/**
 * People routes (Canon §14).
 *
 * Every lifecycle transition is `POST /<record>/:id/transition` carrying the
 * machine's own event name, rather than a verb-per-transition endpoint. There
 * are around ninety transitions across the eleven machines; as endpoints they
 * would be ninety route handlers whose only difference is a string, and the
 * machine already knows which ones are legal from where.
 *
 * A read returns `availableTransitions` alongside the record, so a surface
 * renders exactly the actions that exist rather than guessing from the status
 * and going stale when a diagram changes.
 */

import { Router } from 'express';
import { z } from 'zod';
import {
  HR_MACHINES,
  employmentRelationshipMachine,
  leaveRequestMachine,
  requisitionMachine,
  applicationMachine,
  positionMachine,
  assignmentMachine,
  compensationRecordMachine,
  onboardingMachine,
  offboardingMachine,
  goalMachine,
  workAttendanceMachine,
  payrollMachine,
  CAPABILITY_TIERS,
  type EmploymentEvent,
  type LeaveRequestEvent,
  type RequisitionEvent,
  type ApplicationEvent,
  type PositionEvent,
  type AssignmentRequestEvent,
  type CompensationEvent,
  type OnboardingEvent,
  type OffboardingEvent,
  type GoalEvent,
  type WorkAttendanceEvent,
  type PayrollEvent,
  type CapabilityTier,
  type NonTierState,
  type ContradictionType,
  type PerformanceEvidenceKind,
} from '@kaizen/shared';
import { handler, str, bool, date, numeric } from '../lib/http.js';
import { prisma, num } from '../platform/db.js';
import { currentAuth } from '../platform/context.js';
import { ApiError } from '../platform/errors.js';
import { assertCan, canSeeMoney } from '../platform/permissions.js';
import {
  listOrgUnits, createOrgUnit, listJobs, createJob,
  listPositions, createPosition, transitionPosition,
  listEmployments, getEmployment, hire, transitionEmployment, setConfirmationState,
  proposeAssignment, transitionAssignment,
  proposeCompensation, transitionCompensation, currentCompensation,
  transitionOnboarding, transitionOffboarding,
  headcountByDivision,
} from '../domains/employment.js';
import {
  listRequisitions, createRequisition, transitionRequisition,
  listApplications, createApplication, transitionApplication,
  joinFromApplication, hiringFunnel,
} from '../domains/hiring.js';
import {
  listLeaveTypes, createLeaveType, accrueEntitlement, leaveBalances, leaveLedger,
  listLeaveRequests, createLeaveRequest, transitionLeaveRequest,
  recordAttendance, transitionAttendance, attendanceForPeriod, lockAttendancePeriod,
} from '../domains/leave.js';
import {
  listPayrollRuns, getPayrollRun, openPayrollRun, setInstructionAmounts,
  transitionPayrollRun, payrollCostByDivision, payrollTrend,
} from '../domains/payroll.js';
import {
  listSkills, createSkill, capabilitiesForParty, assertClaim, addEvidence,
  verifyClaim, recordContradiction, changeClaimState, findCapableParties,
} from '../domains/capability.js';
import {
  listGoals, createGoal, transitionGoal, listEvidence, recordEvidence,
  listLearningActivities, createLearningActivity, enrolInLearning, completeLearning,
  outstandingCompliance,
} from '../domains/performance.js';

const router = Router();

/** `{ event, note }` — the shape every transition endpoint takes. */
const transitionBody = z.object({ event: z.string().min(1), note: z.string().optional() });

function parseTransition(body: unknown): { event: string; note?: string } {
  const parsed = transitionBody.safeParse(body);
  if (!parsed.success) throw ApiError.badRequest('A transition needs an `event`.', parsed.error.flatten());
  return parsed.data;
}

// ---------------------------------------------------------------------------
// The machines themselves, so a surface can render a lifecycle it has not been
// taught. This is the same data the API enforces against — there is no second
// copy of the diagrams in the client.
// ---------------------------------------------------------------------------

router.get(
  '/machines',
  handler(async () => {
    await assertCan({ resource: 'employees', verb: 'view' });
    return Object.entries(HR_MACHINES).map(([key, machine]) => ({
      key,
      name: machine.name,
      states: Object.keys(machine.transitions),
      transitions: machine.transitions,
      terminalStates: Object.keys(machine.transitions).filter((s) =>
        machine.isTerminal(s as never),
      ),
    }));
  }),
);

// ---------------------------------------------------------------------------
// Org structure
// ---------------------------------------------------------------------------

router.get('/org-units', handler(async () => listOrgUnits()));

router.post(
  '/org-units',
  handler(async (req) => {
    const body = z
      .object({
        name: z.string().min(1),
        unitType: z.string().optional(),
        division: z.string().nullish(),
        parentId: z.string().nullish(),
      })
      .parse(req.body);
    return createOrgUnit(body);
  }),
);

router.get('/jobs', handler(async () => listJobs()));

router.post(
  '/jobs',
  handler(async (req) => {
    const body = z
      .object({ title: z.string().min(1), jobFamily: z.string().min(1), jobLevel: z.string().min(1) })
      .parse(req.body);
    return createJob(body);
  }),
);

router.get(
  '/positions',
  handler(async (req) => {
    const rows = await listPositions({ status: str(req.query.status), orgUnitId: str(req.query.orgUnitId) });
    return rows.map((p) => ({
      ...p,
      availableTransitions: positionMachine.allowedEvents(p.status as never),
    }));
  }),
);

router.post(
  '/positions',
  handler(async (req) => {
    const body = z
      .object({
        orgUnitId: z.string(),
        jobId: z.string(),
        location: z.string().optional(),
        reportingPositionId: z.string().nullish(),
        isLeadPosition: z.boolean().optional(),
        budgetLineId: z.string().nullish(),
      })
      .parse(req.body);
    return createPosition(body);
  }),
);

router.post(
  '/positions/:id/transition',
  handler(async (req) => {
    const { event, note } = parseTransition(req.body);
    return transitionPosition(req.params.id, event as PositionEvent, note);
  }),
);

// ---------------------------------------------------------------------------
// Employment
// ---------------------------------------------------------------------------

router.get(
  '/employees',
  handler(async (req) => {
    const rows = await listEmployments({ status: str(req.query.status) });
    return rows.map((e) => ({
      id: e.id,
      recordCode: e.recordCode,
      personId: e.personId,
      fullName: e.person.fullName,
      primaryEmail: e.person.primaryEmail,
      status: e.status,
      confirmationState: e.confirmationState,
      hireEffectiveDate: e.hireEffectiveDate.toISOString(),
      legalEntity: e.legalEntity,
      jobTitle: e.assignments[0]?.position.job.title ?? null,
      orgUnit: e.assignments[0]?.position.orgUnit.name ?? null,
      division: e.assignments[0]?.position.orgUnit.division ?? null,
      availableTransitions: employmentRelationshipMachine.allowedEvents(e.status as never),
    }));
  }),
);

router.get(
  '/employees/:id',
  handler(async (req) => {
    const e = await getEmployment(req.params.id);
    const money = await canSeeMoney('compensation');
    const pay = money ? await currentCompensation(e.id) : null;

    return {
      ...e,
      // Statutory identifiers are `regulated` and are structurally excluded
      // from the projection rather than nulled — a null still announces that
      // something is being withheld about this person.
      person: { ...e.person, nationalId: undefined },
      panNumber: undefined,
      aadhaarReference: undefined,
      uanNumber: undefined,
      currentCompensation: pay ? { amount: num(pay.amount), currency: pay.currency, effectiveFrom: pay.effectiveFrom } : null,
      availableTransitions: employmentRelationshipMachine.allowedEvents(e.status as never),
      onboardingTransitions: e.onboarding ? onboardingMachine.allowedEvents(e.onboarding.status as never) : [],
      offboardingTransitions: e.offboarding ? offboardingMachine.allowedEvents(e.offboarding.status as never) : [],
    };
  }),
);

router.post(
  '/employees',
  handler(async (req) => {
    const body = z
      .object({
        personId: z.string(),
        positionId: z.string(),
        hireEffectiveDate: z.coerce.date(),
        legalEntity: z.string().optional(),
        noticePeriodDays: z.number().int().optional(),
        branch: z.string().nullish(),
      })
      .parse(req.body);
    return hire(body);
  }),
);

router.post(
  '/employees/:id/transition',
  handler(async (req) => {
    const body = z
      .object({
        event: z.string().min(1),
        note: z.string().optional(),
        separationType: z.string().nullish(),
        rehireEligible: z.boolean().nullish(),
        rehireIneligibleReason: z.string().nullish(),
      })
      .parse(req.body);
    return transitionEmployment(req.params.id, body.event as EmploymentEvent, body);
  }),
);

router.post(
  '/employees/:id/confirmation',
  handler(async (req) => {
    const body = z.object({ state: z.string().min(1), note: z.string().optional() }).parse(req.body);
    return setConfirmationState(req.params.id, body.state, body.note);
  }),
);

// --- assignments and compensation ------------------------------------------

router.post(
  '/assignments',
  handler(async (req) => {
    const body = z
      .object({
        employmentRelationshipId: z.string(),
        positionId: z.string(),
        managerPositionId: z.string().nullish(),
        reasonCode: z.string(),
        effectiveFrom: z.coerce.date(),
        correlationId: z.string().nullish(),
      })
      .parse(req.body);
    return proposeAssignment(body);
  }),
);

router.post(
  '/assignments/:id/transition',
  handler(async (req) => {
    const { event, note } = parseTransition(req.body);
    return transitionAssignment(req.params.id, event as AssignmentRequestEvent, note);
  }),
);

router.get(
  '/employees/:id/compensation',
  handler(async (req) => {
    await assertCan({ resource: 'compensation', verb: 'view' });
    const auth = currentAuth();
    const money = await canSeeMoney('compensation');

    const rows = await prisma.compensationRecord.findMany({
      where: { tenantId: auth.tenantId, employmentRelationshipId: req.params.id },
      orderBy: { effectiveFrom: 'desc' },
    });

    return rows.map((r) => ({
      id: r.id,
      revisionReason: r.revisionReason,
      status: r.status,
      currency: r.currency,
      effectiveFrom: r.effectiveFrom.toISOString(),
      effectiveTo: r.effectiveTo?.toISOString() ?? null,
      linkedAssignmentId: r.linkedAssignmentId,
      // Withheld rather than absent, so the surface can say so out loud.
      amount: money ? num(r.amount) : null,
      basicPay: money ? num(r.basicPay) : null,
      availableTransitions: compensationRecordMachine.allowedEvents(r.status as never),
    }));
  }),
);

router.post(
  '/compensation',
  handler(async (req) => {
    const body = z
      .object({
        employmentRelationshipId: z.string(),
        revisionReason: z.string(),
        amount: z.number(),
        basicPay: z.number().nullish(),
        effectiveFrom: z.coerce.date(),
        linkedAssignmentId: z.string().nullish(),
        currency: z.string().optional(),
      })
      .parse(req.body);
    return proposeCompensation(body);
  }),
);

router.post(
  '/compensation/:id/transition',
  handler(async (req) => {
    const { event, note } = parseTransition(req.body);
    return transitionCompensation(req.params.id, event as CompensationEvent, note);
  }),
);

// --- onboarding / offboarding ----------------------------------------------

router.post(
  '/onboardings/:id/transition',
  handler(async (req) => {
    const { event, note } = parseTransition(req.body);
    return transitionOnboarding(req.params.id, event as OnboardingEvent, note);
  }),
);

router.post(
  '/offboardings/:id/transition',
  handler(async (req) => {
    const { event, note } = parseTransition(req.body);
    return transitionOffboarding(req.params.id, event as OffboardingEvent, note);
  }),
);

// ---------------------------------------------------------------------------
// Hiring
// ---------------------------------------------------------------------------

router.get(
  '/requisitions',
  handler(async (req) => {
    const rows = await listRequisitions({ status: str(req.query.status) });
    return rows.map((r) => ({
      ...r,
      openApplications: r.applications.filter((a) => !['Rejected', 'Withdrawn', 'Joined'].includes(a.status)).length,
      availableTransitions: requisitionMachine.allowedEvents(r.status as never),
    }));
  }),
);

router.post(
  '/requisitions',
  handler(async (req) => {
    const body = z
      .object({
        positionId: z.string(),
        budgetLineId: z.string().nullish(),
        targetStartDate: z.coerce.date().nullish(),
      })
      .parse(req.body);
    return createRequisition(body);
  }),
);

router.post(
  '/requisitions/:id/transition',
  handler(async (req) => {
    const { event, note } = parseTransition(req.body);
    return transitionRequisition(req.params.id, event as RequisitionEvent, note);
  }),
);

router.get(
  '/applications',
  handler(async (req) => {
    const rows = await listApplications({
      requisitionId: str(req.query.requisitionId),
      status: str(req.query.status),
    });
    return rows.map((a) => ({
      ...a,
      availableTransitions: applicationMachine.allowedEvents(a.status as never),
    }));
  }),
);

router.post(
  '/applications',
  handler(async (req) => {
    const body = z.object({ requisitionId: z.string(), candidatePartyId: z.string() }).parse(req.body);
    return createApplication(body);
  }),
);

router.post(
  '/applications/:id/transition',
  handler(async (req) => {
    const body = z
      .object({
        event: z.string().min(1),
        note: z.string().optional(),
        rejectionReason: z.string().optional(),
        screeningOutcome: z.string().optional(),
      })
      .parse(req.body);
    return transitionApplication(req.params.id, body.event as ApplicationEvent, body);
  }),
);

router.post(
  '/applications/:id/join',
  handler(async (req) => {
    const body = z
      .object({
        hireEffectiveDate: z.coerce.date(),
        legalEntity: z.string().optional(),
        noticePeriodDays: z.number().int().optional(),
        branch: z.string().nullish(),
      })
      .parse(req.body);
    return joinFromApplication(req.params.id, body);
  }),
);

router.get('/hiring/funnel', handler(async () => hiringFunnel()));

// ---------------------------------------------------------------------------
// Leave
// ---------------------------------------------------------------------------

router.get('/leave-types', handler(async () => listLeaveTypes()));

router.post(
  '/leave-types',
  handler(async (req) => {
    const body = z
      .object({
        code: z.string().min(1),
        name: z.string().min(1),
        employmentStateAffecting: z.boolean().optional(),
        statutory: z.boolean().optional(),
        annualEntitlementDays: z.number().optional(),
      })
      .parse(req.body);
    return createLeaveType(body);
  }),
);

router.get(
  '/employees/:id/leave-balances',
  handler(async (req) => {
    const rows = await leaveBalances(req.params.id);
    return rows.map((b) => ({
      id: b.id,
      leaveTypeId: b.leaveTypeId,
      leaveTypeName: b.leaveType.name,
      leaveTypeCode: b.leaveType.code,
      balanceDays: num(b.balanceDays),
      heldDays: num(b.heldDays),
      /** What can actually be booked: the balance less what is already promised. */
      availableDays: (num(b.balanceDays) ?? 0) - (num(b.heldDays) ?? 0),
    }));
  }),
);

router.get(
  '/leave-balances/:id/ledger',
  handler(async (req) => {
    const rows = await leaveLedger(req.params.id);
    return rows.map((t) => ({
      id: t.id,
      txnType: t.txnType,
      amountDays: num(t.amountDays),
      note: t.note,
      leaveRequestId: t.leaveRequestId,
      createdAt: t.createdAt.toISOString(),
    }));
  }),
);

router.post(
  '/leave-balances/accrue',
  handler(async (req) => {
    const body = z
      .object({
        employmentRelationshipId: z.string(),
        leaveTypeId: z.string(),
        days: z.number(),
        note: z.string().optional(),
      })
      .parse(req.body);
    return accrueEntitlement(body);
  }),
);

router.get(
  '/leave-requests',
  handler(async (req) => {
    const rows = await listLeaveRequests({
      status: str(req.query.status),
      employmentRelationshipId: str(req.query.employmentRelationshipId),
    });
    return rows.map((r) => ({
      id: r.id,
      recordCode: r.recordCode,
      employmentRelationshipId: r.employmentRelationshipId,
      fullName: r.employmentRelationship.person.fullName,
      leaveTypeName: r.leaveType.name,
      startDate: r.startDate.toISOString(),
      endDate: r.endDate.toISOString(),
      days: num(r.days),
      reason: r.reason,
      status: r.status,
      availableTransitions: leaveRequestMachine.allowedEvents(r.status as never),
    }));
  }),
);

router.post(
  '/leave-requests',
  handler(async (req) => {
    const body = z
      .object({
        employmentRelationshipId: z.string(),
        leaveTypeId: z.string(),
        startDate: z.coerce.date(),
        endDate: z.coerce.date(),
        days: z.number().optional(),
        reason: z.string().nullish(),
      })
      .parse(req.body);
    return createLeaveRequest(body);
  }),
);

router.post(
  '/leave-requests/:id/transition',
  handler(async (req) => {
    const { event, note } = parseTransition(req.body);
    return transitionLeaveRequest(req.params.id, event as LeaveRequestEvent, note);
  }),
);

// ---------------------------------------------------------------------------
// Attendance
// ---------------------------------------------------------------------------

router.get(
  '/employees/:id/attendance',
  handler(async (req) => {
    const payPeriod = str(req.query.payPeriod) ?? new Date().toISOString().slice(0, 7);
    const rows = await attendanceForPeriod(req.params.id, payPeriod);
    return rows.map((a) => ({
      id: a.id,
      workDate: a.workDate.toISOString().slice(0, 10),
      workedMinutes: a.workedMinutes,
      overtimeMinutes: a.overtimeMinutes,
      status: a.status,
      missingPunch: a.missingPunch,
      note: a.note,
      availableTransitions: workAttendanceMachine.allowedEvents(a.status as never),
    }));
  }),
);

router.post(
  '/attendance',
  handler(async (req) => {
    const body = z
      .object({
        employmentRelationshipId: z.string(),
        workDate: z.coerce.date(),
        workedMinutes: z.number().int().min(0),
        overtimeMinutes: z.number().int().min(0).optional(),
        missingPunch: z.boolean().optional(),
        note: z.string().nullish(),
      })
      .parse(req.body);
    return recordAttendance(body);
  }),
);

router.post(
  '/attendance/:id/transition',
  handler(async (req) => {
    const { event, note } = parseTransition(req.body);
    return transitionAttendance(req.params.id, event as WorkAttendanceEvent, note);
  }),
);

router.post(
  '/attendance/lock',
  handler(async (req) => {
    const body = z.object({ payPeriod: z.string().regex(/^\d{4}-\d{2}$/) }).parse(req.body);
    return lockAttendancePeriod(body.payPeriod);
  }),
);

// ---------------------------------------------------------------------------
// Payroll
// ---------------------------------------------------------------------------

router.get(
  '/payroll/runs',
  handler(async () => {
    const money = await canSeeMoney('payroll');
    const runs = await listPayrollRuns();
    return runs.map((r) => ({
      id: r.id,
      recordCode: r.recordCode,
      payPeriod: r.payPeriod,
      status: r.status,
      headcount: r.headcount,
      grossTotal: money ? num(r.grossTotal) : null,
      netTotal: money ? num(r.netTotal) : null,
      approvedAt: r.approvedAt?.toISOString() ?? null,
      disbursedAt: r.disbursedAt?.toISOString() ?? null,
      availableTransitions: payrollMachine.allowedEvents(r.status as never),
    }));
  }),
);

router.get(
  '/payroll/runs/:id',
  handler(async (req) => {
    const run = await getPayrollRun(req.params.id);
    const money = await canSeeMoney('payroll');

    return {
      id: run.id,
      recordCode: run.recordCode,
      payPeriod: run.payPeriod,
      status: run.status,
      headcount: run.headcount,
      grossTotal: money ? num(run.grossTotal) : null,
      netTotal: money ? num(run.netTotal) : null,
      availableTransitions: payrollMachine.allowedEvents(run.status as never),
      instructions: run.instructions.map((i) => ({
        id: i.id,
        employmentRelationshipId: i.employmentRelationshipId,
        fullName: i.employmentRelationship.person.fullName,
        division: i.division,
        status: i.status,
        grossAmount: money ? num(i.grossAmount) : null,
        deductions: money ? num(i.deductions) : null,
        netAmount: money ? num(i.netAmount) : null,
      })),
    };
  }),
);

router.post(
  '/payroll/runs',
  handler(async (req) => {
    const body = z.object({ payPeriod: z.string().regex(/^\d{4}-\d{2}$/) }).parse(req.body);
    return openPayrollRun(body.payPeriod);
  }),
);

router.post(
  '/payroll/runs/:id/transition',
  handler(async (req) => {
    const { event, note } = parseTransition(req.body);
    return transitionPayrollRun(req.params.id, event as PayrollEvent, note);
  }),
);

router.patch(
  '/payroll/instructions/:id',
  handler(async (req) => {
    const body = z
      .object({ grossAmount: z.number().optional(), deductions: z.number().optional() })
      .parse(req.body);
    return setInstructionAmounts(req.params.id, body);
  }),
);

router.get(
  '/payroll/cost-by-division',
  handler(async (req) => {
    const payPeriod = str(req.query.payPeriod) ?? new Date().toISOString().slice(0, 7);
    return payrollCostByDivision(payPeriod);
  }),
);

router.get(
  '/payroll/trend',
  handler(async (req) => payrollTrend(numeric(req.query.months) ?? 12)),
);

// ---------------------------------------------------------------------------
// Capability
// ---------------------------------------------------------------------------

router.get('/skills', handler(async () => listSkills()));

router.post(
  '/skills',
  handler(async (req) => {
    const body = z
      .object({
        name: z.string().min(1),
        halfLifeMonths: z.number().int().optional(),
        proficiencyScale: z.unknown().optional(),
      })
      .parse(req.body);
    return createSkill(body);
  }),
);

router.get(
  '/people/:partyId/capabilities',
  handler(async (req) => capabilitiesForParty(req.params.partyId)),
);

router.post(
  '/capabilities',
  handler(async (req) => {
    const body = z
      .object({
        partyId: z.string(),
        skillId: z.string().nullish(),
        vertical: z.string().nullish(),
        tier: z.enum(CAPABILITY_TIERS as [CapabilityTier, ...CapabilityTier[]]),
        confidenceScore: z.number().min(0).max(1).optional(),
        claimedProficiencyLevel: z.number().int().nullish(),
        evidence: z.string().nullish(),
      })
      .parse(req.body);
    return assertClaim(body);
  }),
);

router.post(
  '/capabilities/:id/evidence',
  handler(async (req) => {
    const body = z.object({ description: z.string().min(1), sourceRef: z.string().nullish() }).parse(req.body);
    return addEvidence(req.params.id, body);
  }),
);

router.post(
  '/capabilities/:id/verify',
  handler(async (req) => {
    const body = z
      .object({
        secondVerifierPartyId: z.string().nullish(),
        feedsCompensationOrPromotionOrMobility: z.boolean().optional(),
        verifierIsManagerOnly: z.boolean().optional(),
        note: z.string().nullish(),
      })
      .parse(req.body);
    return verifyClaim(req.params.id, body);
  }),
);

router.post(
  '/capabilities/:id/contradiction',
  handler(async (req) => {
    const body = z
      .object({
        type: z.enum([
          'tier_conflict',
          'level_conflict',
          'temporal_conflict',
          'issuer_conflict',
          'identity_conflict',
        ]),
        score: z.number(),
        detail: z.string().optional(),
      })
      .parse(req.body);
    return recordContradiction(req.params.id, body as { type: ContradictionType; score: number; detail?: string });
  }),
);

router.post(
  '/capabilities/:id/state',
  handler(async (req) => {
    const body = z
      .object({
        state: z.enum(['contradicted', 'retracted', 'revoked', 'superseded']),
        note: z.string().optional(),
      })
      .parse(req.body);
    return changeClaimState(req.params.id, body.state as NonTierState, body.note);
  }),
);

router.get(
  '/skills/:id/capable',
  handler(async (req) => {
    const minTier = (str(req.query.minTier) ?? 'assessed') as CapabilityTier;
    return findCapableParties(req.params.id, minTier);
  }),
);

// ---------------------------------------------------------------------------
// Performance and learning
// ---------------------------------------------------------------------------

router.get(
  '/employees/:id/goals',
  handler(async (req) => {
    const rows = await listGoals(req.params.id);
    return rows.map((g) => ({
      ...g,
      availableTransitions: goalMachine.allowedEvents(g.status as never),
    }));
  }),
);

router.post(
  '/goals',
  handler(async (req) => {
    const body = z
      .object({
        employmentRelationshipId: z.string(),
        description: z.string().min(1),
        keyResultRef: z.string().nullish(),
        periodLabel: z.string().nullish(),
        dueAt: z.coerce.date().nullish(),
      })
      .parse(req.body);
    return createGoal(body);
  }),
);

router.post(
  '/goals/:id/transition',
  handler(async (req) => {
    const { event, note } = parseTransition(req.body);
    return transitionGoal(req.params.id, event as GoalEvent, note);
  }),
);

router.get('/employees/:id/evidence', handler(async (req) => listEvidence(req.params.id)));

router.post(
  '/evidence',
  handler(async (req) => {
    const body = z
      .object({
        employmentRelationshipId: z.string(),
        kind: z.enum(['milestone', 'quality_outcome', 'corrective_note', 'manager_note', 'self_note']),
        description: z.string().min(1),
        caseScoped: z.boolean().optional(),
        caseRef: z.string().nullish(),
      })
      .parse(req.body);
    return recordEvidence(body as { employmentRelationshipId: string; kind: PerformanceEvidenceKind; description: string; caseScoped?: boolean; caseRef?: string | null });
  }),
);

router.get('/learning-activities', handler(async () => listLearningActivities()));

router.post(
  '/learning-activities',
  handler(async (req) => {
    const body = z
      .object({
        title: z.string().min(1),
        isCompliance: z.boolean().optional(),
        cost: z.number().optional(),
        courseId: z.string().nullish(),
      })
      .parse(req.body);
    return createLearningActivity(body);
  }),
);

router.post(
  '/learning-records',
  handler(async (req) => {
    const body = z.object({ employmentRelationshipId: z.string(), learningActivityId: z.string() }).parse(req.body);
    return enrolInLearning(body);
  }),
);

router.post(
  '/learning-records/:id/complete',
  handler(async (req) => {
    const body = z.object({ skillId: z.string().nullish() }).parse(req.body ?? {});
    return completeLearning(req.params.id, body);
  }),
);

router.get('/learning/outstanding-compliance', handler(async () => outstandingCompliance()));

// ---------------------------------------------------------------------------
// Rollups for the Command Center
// ---------------------------------------------------------------------------

router.get('/headcount-by-division', handler(async () => headcountByDivision()));

export default router;
