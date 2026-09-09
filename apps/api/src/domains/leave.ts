/**
 * Leave and attendance (Canon §14.2, §14.3 Diagram 14.2, §14.4 rows 11-12).
 *
 * The rule that shapes this file: a leave balance is never written directly.
 * Every movement is a LEAVE_TRANSACTION, and the balance column is a cached
 * sum of them. That is what makes "why is my balance 8.5 and not 11" a
 * question with an answer, and what lets a disputed balance be recomputed
 * rather than argued about.
 *
 * Three transitions move it: approval places a hold, completion turns the hold
 * into a deduction, and cancellation or withdrawal reverses it.
 */

import {
  EVENTS,
  leaveRequestMachine,
  workAttendanceMachine,
  LEAVE_POSTING_ON_EVENT,
  LEAVE_REQUEST_EVENT_VERB,
  WORK_ATTENDANCE_EVENT_VERB,
  type LeaveRequestState,
  type LeaveRequestEvent,
  type LeaveTxnType,
  type WorkAttendanceState,
  type WorkAttendanceEvent,
} from '@kaizen/shared';
import { prisma, num, type DbTx } from '../platform/db.js';
import { currentAuth } from '../platform/context.js';
import { emit } from '../platform/eventBus.js';
import { nextRecordCode } from '../platform/recordCode.js';
import { ApiError } from '../platform/errors.js';
import { assertCan } from '../platform/permissions.js';
import { transition } from '../platform/lifecycle.js';
import { raiseException } from '../platform/exceptions.js';

// ---------------------------------------------------------------------------
// Leave types and balances
// ---------------------------------------------------------------------------

export async function listLeaveTypes() {
  const auth = currentAuth();
  await assertCan({ resource: 'leave', verb: 'view' });
  return prisma.leaveType.findMany({ where: { tenantId: auth.tenantId }, orderBy: { name: 'asc' } });
}

export async function createLeaveType(input: {
  code: string;
  name: string;
  employmentStateAffecting?: boolean;
  statutory?: boolean;
  annualEntitlementDays?: number;
}) {
  const auth = currentAuth();
  await assertCan({ resource: 'leave', verb: 'create' });
  return prisma.leaveType.create({
    data: {
      tenantId: auth.tenantId,
      code: input.code,
      name: input.name,
      employmentStateAffecting: input.employmentStateAffecting ?? false,
      statutory: input.statutory ?? false,
      annualEntitlementDays: input.annualEntitlementDays ?? 0,
    },
  });
}

/**
 * Posts a movement and recomputes the balance from the ledger.
 *
 * The recompute is a sum over the transactions rather than an increment of the
 * stored figure: an increment drifts the moment one write is retried or lost,
 * and the drift is invisible. Summing costs a query and cannot drift.
 *
 * The signs, once, because they are the whole contract:
 *
 * - `accrual` is positive — the entitlement arriving.
 * - `hold` is negative — approval commits the days, and the employee should
 *   see them leave the balance then, not a month later when the leave is over.
 * - `deduction` is zero — completion settles a hold that already moved the
 *   balance. It is written anyway, because "these days were actually taken" is
 *   a different fact from "these days were promised", and the ledger has to be
 *   able to tell them apart.
 * - `reversal` is positive — a cancelled or withdrawn request giving the days
 *   back.
 * - `adjustment` is signed by the caller.
 *
 * `heldDays` is deliberately not derived from that arithmetic. It is what is
 * approved and not yet taken, which is a fact about request states, and
 * reading it from the requests means it cannot disagree with them.
 */
export async function postLeaveTransaction(
  tx: DbTx,
  input: {
    tenantId: string;
    leaveBalanceId: string;
    employmentRelationshipId: string;
    leaveTypeId: string;
    leaveRequestId?: string | null;
    txnType: LeaveTxnType;
    amountDays: number;
    note?: string | null;
    createdById?: string | null;
  },
) {
  await tx.leaveTransaction.create({
    data: {
      tenantId: input.tenantId,
      leaveBalanceId: input.leaveBalanceId,
      leaveRequestId: input.leaveRequestId ?? null,
      txnType: input.txnType,
      amountDays: input.amountDays,
      note: input.note ?? null,
      createdById: input.createdById ?? null,
    },
  });

  const ledger = await tx.leaveTransaction.aggregate({
    where: { leaveBalanceId: input.leaveBalanceId },
    _sum: { amountDays: true },
  });

  const approved = await tx.leaveRequest.aggregate({
    where: {
      tenantId: input.tenantId,
      employmentRelationshipId: input.employmentRelationshipId,
      leaveTypeId: input.leaveTypeId,
      deletedAt: null,
      // Approved and started, but not yet completed or cancelled.
      status: { in: ['Approved', 'InProgress', 'Extended'] },
    },
    _sum: { days: true },
  });

  return tx.leaveBalance.update({
    where: { id: input.leaveBalanceId },
    data: {
      balanceDays: num(ledger._sum.amountDays) ?? 0,
      heldDays: num(approved._sum.days) ?? 0,
    },
  });
}

/** Grants an annual entitlement as an accrual, so it appears in the ledger too. */
export async function accrueEntitlement(input: {
  employmentRelationshipId: string;
  leaveTypeId: string;
  days: number;
  note?: string;
}) {
  const auth = currentAuth();
  await assertCan({ resource: 'leave', verb: 'edit' });

  return prisma.$transaction(async (tx) => {
    const balance = await tx.leaveBalance.upsert({
      where: {
        employmentRelationshipId_leaveTypeId: {
          employmentRelationshipId: input.employmentRelationshipId,
          leaveTypeId: input.leaveTypeId,
        },
      },
      create: {
        tenantId: auth.tenantId,
        employmentRelationshipId: input.employmentRelationshipId,
        leaveTypeId: input.leaveTypeId,
      },
      update: {},
    });

    return postLeaveTransaction(tx, {
      tenantId: auth.tenantId,
      leaveBalanceId: balance.id,
      employmentRelationshipId: input.employmentRelationshipId,
      leaveTypeId: input.leaveTypeId,
      txnType: 'accrual',
      amountDays: input.days,
      note: input.note ?? 'annual entitlement',
      createdById: auth.partyId,
    });
  });
}

export async function leaveBalances(employmentRelationshipId: string) {
  const auth = currentAuth();
  await assertCan({ resource: 'leave', verb: 'view' });
  return prisma.leaveBalance.findMany({
    where: { tenantId: auth.tenantId, employmentRelationshipId },
    include: { leaveType: true },
  });
}

/** The ledger behind one balance — the answer to "why is it this number". */
export async function leaveLedger(leaveBalanceId: string) {
  const auth = currentAuth();
  await assertCan({ resource: 'leave', verb: 'view' });
  return prisma.leaveTransaction.findMany({
    where: { tenantId: auth.tenantId, leaveBalanceId },
    orderBy: { createdAt: 'desc' },
    take: 200,
  });
}

// ---------------------------------------------------------------------------
// Leave requests
// ---------------------------------------------------------------------------

/** Inclusive whole-day count. Half-days are recorded by overriding `days`. */
function dayCount(start: Date, end: Date): number {
  const ms = end.getTime() - start.getTime();
  return Math.max(1, Math.round(ms / 86_400_000) + 1);
}

export async function listLeaveRequests(filter: { status?: string; employmentRelationshipId?: string } = {}) {
  const auth = currentAuth();
  await assertCan({ resource: 'leave', verb: 'view' });

  return prisma.leaveRequest.findMany({
    where: {
      tenantId: auth.tenantId,
      deletedAt: null,
      ...(filter.status ? { status: filter.status } : {}),
      ...(filter.employmentRelationshipId ? { employmentRelationshipId: filter.employmentRelationshipId } : {}),
    },
    include: {
      leaveType: true,
      employmentRelationship: { include: { person: { select: { id: true, fullName: true } } } },
    },
    orderBy: { startDate: 'desc' },
  });
}

export async function createLeaveRequest(input: {
  employmentRelationshipId: string;
  leaveTypeId: string;
  startDate: Date;
  endDate: Date;
  days?: number;
  reason?: string | null;
}) {
  const auth = currentAuth();
  // Coarse first, so a caller holding no grant at all is refused before the
  // lookup and the id cannot be used as an existence oracle.
  await assertCan({ resource: 'leave', verb: 'create' });

  if (input.endDate < input.startDate) {
    throw ApiError.unprocessable('A leave request cannot end before it starts.');
  }

  const employment = await prisma.employmentRelationship.findFirst({
    where: { id: input.employmentRelationshipId, tenantId: auth.tenantId },
  });
  if (!employment) throw ApiError.notFound('Employment relationship');

  // Then again against whose record this is. The evaluator's WHERE axis passes
  // unconditionally when no `record` is given, so a grant held at `own` scope —
  // which is how every workspace role holds `leave` — is only actually enforced
  // by supplying one. Without this an employee can file leave in a colleague's
  // name, with their own free text on it.
  await assertCan({ resource: 'leave', verb: 'create', record: { ownerPartyId: employment.personId } });

  // Overlapping leave is almost always a double entry rather than an
  // intention, and catching it here is cheaper than unpicking two holds later.
  const overlap = await prisma.leaveRequest.findFirst({
    where: {
      tenantId: auth.tenantId,
      employmentRelationshipId: input.employmentRelationshipId,
      deletedAt: null,
      status: { in: ['Submitted', 'PendingApproval', 'Approved', 'InProgress', 'Extended'] },
      startDate: { lte: input.endDate },
      endDate: { gte: input.startDate },
    },
  });
  if (overlap) {
    throw ApiError.conflict(
      `This overlaps ${overlap.recordCode}, which runs ${overlap.startDate.toISOString().slice(0, 10)} to ${overlap.endDate.toISOString().slice(0, 10)} and is ${overlap.status}.`,
      { leaveRequestId: overlap.id },
    );
  }

  const recordCode = await nextRecordCode('LVR');
  const request = await prisma.leaveRequest.create({
    data: {
      tenantId: auth.tenantId,
      recordCode,
      employmentRelationshipId: input.employmentRelationshipId,
      leaveTypeId: input.leaveTypeId,
      startDate: input.startDate,
      endDate: input.endDate,
      days: input.days ?? dayCount(input.startDate, input.endDate),
      reason: input.reason ?? null,
    },
  });

  await emit({
    name: EVENTS.LEAVE_REQUEST_CREATED,
    subject: { entityType: 'leave_request', entityId: request.id, recordCode },
    related: [
      { relation: 'requested_by', entityType: 'employment_relationship', entityId: input.employmentRelationshipId },
    ],
    newState: { status: 'Draft', startDate: input.startDate, endDate: input.endDate, days: num(request.days) },
    owner: { partyId: employment.personId },
    impact: { domains: ['hr'] },
  });

  return request;
}

/**
 * Every move along Diagram 14.2, with the balance posting that some of them
 * carry. The posting and the status change happen in one transaction: a hold
 * that survived a failed approval would silently cost the employee days.
 */
export async function transitionLeaveRequest(id: string, event: LeaveRequestEvent, note?: string) {
  const auth = currentAuth();
  const request = await prisma.leaveRequest.findFirst({
    where: { id, tenantId: auth.tenantId },
    include: { employmentRelationship: true, leaveType: true },
  });
  if (!request) throw ApiError.notFound('Leave request');

  const result = await transition({
    machine: leaveRequestMachine,
    eventObject: 'leave',
    verbs: LEAVE_REQUEST_EVENT_VERB,
    resource: 'leave',
    // Approving somebody's leave is a distinct authority from editing the
    // request, and is granted separately.
    verb: event === 'APPROVE' || event === 'REJECT' ? 'approve' : 'edit',
    subjectType: 'leave_request',
    subjectId: id,
    recordCode: request.recordCode,
    ownerPartyId: request.employmentRelationship.personId,
    from: request.status as LeaveRequestState,
    event,
    detail: { days: num(request.days), leaveType: request.leaveType.code },
    reasonNote: note ?? null,
  });

  const posting = LEAVE_POSTING_ON_EVENT[event];
  const days = num(request.days) ?? 0;

  const updated = await prisma.$transaction(async (tx) => {
    // The status moves first. `heldDays` is derived from request states, so
    // posting before the update would compute the hold against the state this
    // transition has just left.
    const row = await tx.leaveRequest.update({
      where: { id },
      data: {
        status: result.to,
        ...(event === 'APPROVE' || event === 'REJECT'
          ? { decidedById: auth.partyId, decidedAt: new Date() }
          : {}),
      },
    });

    if (posting) {
      const balance = await tx.leaveBalance.upsert({
        where: {
          employmentRelationshipId_leaveTypeId: {
            employmentRelationshipId: request.employmentRelationshipId,
            leaveTypeId: request.leaveTypeId,
          },
        },
        create: {
          tenantId: auth.tenantId,
          employmentRelationshipId: request.employmentRelationshipId,
          leaveTypeId: request.leaveTypeId,
        },
        update: {},
      });

      // See the sign contract on postLeaveTransaction: the hold is what moves
      // the balance, completion only settles it, cancellation gives it back.
      const amount = posting === 'reversal' ? days : posting === 'deduction' ? 0 : -days;

      await postLeaveTransaction(tx, {
        tenantId: auth.tenantId,
        leaveBalanceId: balance.id,
        employmentRelationshipId: request.employmentRelationshipId,
        leaveTypeId: request.leaveTypeId,
        leaveRequestId: id,
        txnType: posting,
        amountDays: amount,
        note: note ?? `${event} on ${request.recordCode}`,
        createdById: auth.partyId,
      });
    }

    return row;
  });

  if (posting) {
    await emit({
      name: EVENTS.LEAVE_BALANCE_POSTED,
      subject: { entityType: 'leave_request', entityId: id, recordCode: request.recordCode },
      newState: { posting, days, leaveType: request.leaveType.code },
      owner: { partyId: request.employmentRelationship.personId },
      impact: { domains: ['hr'] },
    });
  }

  // Taking leave the employee does not have is not blocked — sometimes it is
  // granted deliberately — but it is never silent.
  if (posting === 'deduction' || posting === 'hold') {
    const balance = await prisma.leaveBalance.findFirst({
      where: { employmentRelationshipId: request.employmentRelationshipId, leaveTypeId: request.leaveTypeId },
    });
    if (balance && (num(balance.balanceDays) ?? 0) < 0) {
      await raiseException({
        code: 'EX-HR-004',
        label: 'Leave taken beyond entitlement',
        severity: 'S2_WARNING',
        subjectType: 'leave_request',
        subjectId: id,
        subjectLabel: request.recordCode,
        detail: `${request.leaveType.name} balance is now ${num(balance.balanceDays)} days. The request was allowed; the shortfall needs a decision.`,
        ownerPartyId: request.employmentRelationship.personId,
        triggerFingerprint: `leave_negative:${request.employmentRelationshipId}:${request.leaveTypeId}`,
        ladderRung: 1,
      });
    }
  }

  // Leave that affects employment state moves the relationship too, so the
  // two never disagree about whether somebody is at work.
  if (request.leaveType.employmentStateAffecting) {
    if (event === 'START' && request.employmentRelationship.status === 'Active') {
      await prisma.employmentRelationship.update({
        where: { id: request.employmentRelationshipId },
        data: { status: 'OnLeave' },
      });
    }
    if (event === 'COMPLETE' && request.employmentRelationship.status === 'OnLeave') {
      await prisma.employmentRelationship.update({
        where: { id: request.employmentRelationshipId },
        data: { status: 'Active' },
      });
    }
  }

  return updated;
}

// ---------------------------------------------------------------------------
// Attendance
// ---------------------------------------------------------------------------

export async function recordAttendance(input: {
  employmentRelationshipId: string;
  workDate: Date;
  workedMinutes: number;
  overtimeMinutes?: number;
  missingPunch?: boolean;
  note?: string | null;
}) {
  const auth = currentAuth();
  await assertCan({ resource: 'attendance', verb: 'create' });

  const day = new Date(Date.UTC(
    input.workDate.getUTCFullYear(),
    input.workDate.getUTCMonth(),
    input.workDate.getUTCDate(),
  ));

  const existing = await prisma.workAttendance.findUnique({
    where: { employmentRelationshipId_workDate: { employmentRelationshipId: input.employmentRelationshipId, workDate: day } },
  });

  // A locked day is closed. Correcting it is a regularisation on a reopened
  // record, not an overwrite, because payroll has already read it.
  if (existing?.status === 'Locked') {
    throw ApiError.unprocessable(
      `Attendance for ${day.toISOString().slice(0, 10)} is Locked — the period is closed and payroll has read it. ` +
        'Raise a dispute to reopen it.',
    );
  }

  const row = await prisma.workAttendance.upsert({
    where: { employmentRelationshipId_workDate: { employmentRelationshipId: input.employmentRelationshipId, workDate: day } },
    create: {
      tenantId: auth.tenantId,
      employmentRelationshipId: input.employmentRelationshipId,
      workDate: day,
      workedMinutes: input.workedMinutes,
      overtimeMinutes: input.overtimeMinutes ?? 0,
      missingPunch: input.missingPunch ?? false,
      note: input.note ?? null,
    },
    update: {
      workedMinutes: input.workedMinutes,
      overtimeMinutes: input.overtimeMinutes ?? 0,
      missingPunch: input.missingPunch ?? false,
      note: input.note ?? null,
    },
  });

  await emit({
    name: EVENTS.WORK_ATTENDANCE_RECORDED,
    subject: { entityType: 'work_attendance', entityId: row.id },
    related: [
      { relation: 'worked_by', entityType: 'employment_relationship', entityId: input.employmentRelationshipId },
    ],
    newState: { workDate: day, workedMinutes: input.workedMinutes, missingPunch: row.missingPunch },
    impact: { domains: ['hr'] },
  });

  return row;
}

export async function transitionAttendance(id: string, event: WorkAttendanceEvent, note?: string) {
  const auth = currentAuth();
  const row = await prisma.workAttendance.findFirst({
    where: { id, tenantId: auth.tenantId },
    include: { employmentRelationship: true },
  });
  if (!row) throw ApiError.notFound('Attendance record');

  const result = await transition({
    machine: workAttendanceMachine,
    eventObject: 'work_attendance',
    verbs: WORK_ATTENDANCE_EVENT_VERB,
    resource: 'attendance',
    subjectType: 'work_attendance',
    subjectId: id,
    ownerPartyId: row.employmentRelationship.personId,
    from: row.status as WorkAttendanceState,
    event,
    detail: { workDate: row.workDate },
    reasonNote: note ?? null,
  });

  return prisma.workAttendance.update({ where: { id }, data: { status: result.to, note: note ?? row.note } });
}

export async function attendanceForPeriod(employmentRelationshipId: string, payPeriod: string) {
  const auth = currentAuth();
  await assertCan({ resource: 'attendance', verb: 'view' });

  const [year, month] = payPeriod.split('-').map(Number);
  const from = new Date(Date.UTC(year, month - 1, 1));
  const to = new Date(Date.UTC(year, month, 1));

  return prisma.workAttendance.findMany({
    where: { tenantId: auth.tenantId, employmentRelationshipId, workDate: { gte: from, lt: to } },
    orderBy: { workDate: 'asc' },
  });
}

/**
 * Locks a period's attendance. Payroll reads locked days, so anything still
 * disputed is surfaced first rather than being swept into a lock.
 */
export async function lockAttendancePeriod(payPeriod: string): Promise<{ locked: number; unresolved: number }> {
  const auth = currentAuth();
  await assertCan({ resource: 'attendance', verb: 'edit' });

  const [year, month] = payPeriod.split('-').map(Number);
  const from = new Date(Date.UTC(year, month - 1, 1));
  const to = new Date(Date.UTC(year, month, 1));

  const unresolved = await prisma.workAttendance.count({
    where: { tenantId: auth.tenantId, workDate: { gte: from, lt: to }, status: 'Disputed' },
  });

  if (unresolved > 0) {
    await raiseException({
      code: 'EX-HR-005',
      label: 'Payroll period closed with unresolved attendance',
      severity: 'S2_WARNING',
      subjectType: 'payroll_period',
      subjectId: payPeriod,
      subjectLabel: payPeriod,
      detail: `${unresolved} attendance ${unresolved === 1 ? 'day is' : 'days are'} still Disputed for ${payPeriod}. They are excluded from the lock and must be regularised.`,
      triggerFingerprint: `attendance_unresolved:${payPeriod}`,
      ladderRung: 1,
    });
  }

  const locked = await prisma.workAttendance.updateMany({
    where: { tenantId: auth.tenantId, workDate: { gte: from, lt: to }, status: { in: ['Recorded', 'Regularised'] } },
    data: { status: 'Locked' },
  });

  return { locked: locked.count, unresolved };
}
