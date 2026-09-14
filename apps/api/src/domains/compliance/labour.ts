/**
 * Compliance — F. Labour law and conduct (docs/plan/compliance.md).
 *
 * Holidays and holiday-aware leave arithmetic, leave carry-forward/lapse and
 * encashment, working-hours caps and overtime accrual, statutory register
 * exports, POSH (Internal Committee, complaints, annual report), a structured
 * disciplinary process linked to performance.ts's case-scoped evidence, and
 * the letters a hire or an exit issues.
 */

import {
  carryForwardSplit,
  csvCell,
  encashmentAmount,
  inquiryDueAt as computeInquiryDueAt,
  isoWeekLabel,
  isoWeekRange,
  overtimeAmount,
  REGISTER_NAMES,
  replyDueAt as computeReplyDueAt,
  reportDueAt as computeReportDueAt,
  toCsv as sharedToCsv,
  validateIccComposition,
  workingDayCount,
  buildLetterBody,
  type HrLetterKind,
  type IccMemberFact,
} from '@kaizen/shared';
import { financialYearOf } from '@kaizen/shared';
import { prisma, num, unscopedPrisma, type DbTx } from '../../platform/db.js';
import { currentAuth } from '../../platform/context.js';
import { emit } from '../../platform/eventBus.js';
import { ApiError } from '../../platform/errors.js';
import { assertCan, assertScopeAll } from '../../platform/permissions.js';
import { assertEmploymentVisible } from '../../platform/recordScope.js';
import { auditWrite, auditExport, registerGovernedEntities } from '../../platform/audit.js';
import { raiseException } from '../../platform/exceptions.js';
import { registerHook } from '../../platform/hooks.js';
import type { JobResult } from '../../jobs/scheduler.js';

/** The registers are read by spreadsheet tools that expect RFC 4180 line endings. */
const toCsv = (headers: string[], rows: Array<Array<string | number | null | undefined>>) => sharedToCsv(headers, rows, '\r\n');

registerGovernedEntities('cmp_labour', [
  'holiday',
  'leave_year_close',
  'leave_encashment',
  'working_hours_rule',
  'overtime_accrual',
  'icc_member',
  'posh_complaint',
  'posh_workshop',
  'posh_annual_report',
  'disciplinary_case',
  'hr_letter',
]);

/** The HR operations manager, resolved by role rather than remembered — the deterministic owner for labour exceptions. */
async function hrOpsOwnerId(tenantId: string): Promise<string | null> {
  const affiliation = await unscopedPrisma.affiliation.findFirst({
    where: { tenantId, roleSlug: 'hr_ops_manager', status: 'active' },
    select: { partyId: true },
  });
  return affiliation?.partyId ?? null;
}

function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Holidays
// ---------------------------------------------------------------------------

export async function listHolidays(year?: number) {
  const auth = currentAuth();
  await assertCan({ resource: 'holidays', verb: 'view' });
  const y = year ?? new Date().getUTCFullYear();
  return prisma.holiday.findMany({
    where: { tenantId: auth.tenantId, date: { gte: new Date(Date.UTC(y, 0, 1)), lt: new Date(Date.UTC(y + 1, 0, 1)) } },
    orderBy: { date: 'asc' },
  });
}

export async function createHoliday(input: { date: Date; name: string; kind: string; state?: string | null; note?: string | null }) {
  const auth = currentAuth();
  await assertCan({ resource: 'holidays', verb: 'create' });
  if (!['national', 'state', 'restricted'].includes(input.kind)) {
    throw ApiError.badRequest(`"${input.kind}" is not a holiday kind. Expected national, state or restricted.`);
  }
  const row = await prisma.holiday.create({
    data: {
      tenantId: auth.tenantId,
      date: input.date,
      name: input.name,
      kind: input.kind,
      state: input.state ?? null,
      note: input.note ?? null,
    },
  });
  await auditWrite({ action: 'create', subjectType: 'holiday', subjectId: row.id, after: row as never });
  return row;
}

export async function deleteHoliday(id: string) {
  const auth = currentAuth();
  await assertCan({ resource: 'holidays', verb: 'delete' });
  const row = await prisma.holiday.findFirst({ where: { id, tenantId: auth.tenantId } });
  if (!row) throw ApiError.notFound('Holiday');
  await prisma.holiday.delete({ where: { id } });
  await auditWrite({ action: 'delete', subjectType: 'holiday', subjectId: id, before: row as never });
  return { deleted: true };
}

/** The holiday dates in `[start, end]`, as `YYYY-MM-DD` strings — what `workingDayCount` takes. */
export async function holidayDatesInRange(start: Date, end: Date): Promise<Set<string>> {
  const auth = currentAuth();
  const rows = await prisma.holiday.findMany({
    where: { tenantId: auth.tenantId, date: { gte: start, lte: end } },
    select: { date: true },
  });
  return new Set(rows.map((r) => ymd(r.date)));
}

/** Working-day count for a leave request, holidays and Sundays excluded — what `leave.ts` calls instead of a bare calendar span. */
export async function leaveWorkingDayCount(start: Date, end: Date): Promise<number> {
  const holidays = await holidayDatesInRange(start, end);
  return workingDayCount(start, end, holidays);
}

// ---------------------------------------------------------------------------
// Leave carry-forward, lapse and encashment
// ---------------------------------------------------------------------------

async function basicPayFor(employmentRelationshipId: string, asOf = new Date()): Promise<number> {
  const auth = currentAuth();
  const record = await prisma.compensationRecord.findFirst({
    where: {
      tenantId: auth.tenantId,
      employmentRelationshipId,
      status: 'Effective',
      effectiveFrom: { lte: asOf },
      OR: [{ effectiveTo: null }, { effectiveTo: { gt: asOf } }],
    },
    orderBy: { effectiveFrom: 'desc' },
  });
  return num(record?.basicPay) ?? num(record?.amount) ?? 0;
}

/**
 * Recomputes a leave balance's `balanceDays` from its ledger, the same
 * discipline `leave.ts` posts under. Takes the transaction client explicitly
 * — recomputing against the outer client while the posting transaction is
 * still open would read a ledger that has not committed yet.
 */
async function recomputeLeaveBalance(tx: DbTx, leaveBalanceId: string) {
  const sum = await tx.leaveTransaction.aggregate({
    where: { leaveBalanceId },
    _sum: { amountDays: true },
  });
  await tx.leaveBalance.update({ where: { id: leaveBalanceId }, data: { balanceDays: num(sum._sum.amountDays) ?? 0 } });
}

/**
 * The 1 April carry-forward job (CMP-LAB-004). For every leave type carrying
 * a cap, every balance above it is trimmed to the cap with a `lapse`
 * transaction; every balance at or under it gets a zero-amount `carry_forward`
 * transaction, so the ledger states plainly what happened rather than leaving
 * silence to be read as "nothing to carry". A `LeaveYearClose` row per
 * (leaveTypeId, fy) is the idempotency guard — a second run in the same FY
 * finds it and does nothing.
 */
export async function runLeaveYearClose(): Promise<JobResult> {
  const auth = currentAuth();
  const fy = financialYearOf(new Date());
  const types = await prisma.leaveType.findMany({
    where: { tenantId: auth.tenantId, carryForwardCapDays: { not: null } },
  });

  let processed = 0;
  for (const type of types) {
    const already = await prisma.leaveYearClose.findUnique({
      where: { tenantId_leaveTypeId_fy: { tenantId: auth.tenantId, leaveTypeId: type.id, fy } },
    });
    if (already) continue;

    const cap = num(type.carryForwardCapDays) ?? 0;
    const balances = await prisma.leaveBalance.findMany({ where: { tenantId: auth.tenantId, leaveTypeId: type.id } });

    let closed = 0;
    for (const balance of balances) {
      const current = num(balance.balanceDays) ?? 0;
      const { lapsed } = carryForwardSplit(current, cap);

      await prisma.leaveTransaction.create({
        data: {
          tenantId: auth.tenantId,
          leaveBalanceId: balance.id,
          txnType: lapsed > 0 ? 'lapse' : 'carry_forward',
          amountDays: lapsed > 0 ? -lapsed : 0,
          note:
            lapsed > 0
              ? `FY close ${fy}: ${current} days trimmed to the ${cap}-day carry-forward cap for ${type.name}.`
              : `FY close ${fy}: ${current} days carried forward in full for ${type.name}.`,
        },
      });
      await recomputeLeaveBalance(prisma, balance.id);
      closed += 1;
    }

    await prisma.leaveYearClose.create({
      data: { tenantId: auth.tenantId, leaveTypeId: type.id, fy, balancesClosed: closed },
    });
    await emit({
      name: 'kz.hr.leave_year_close.closed',
      subject: { entityType: 'leave_year_close', entityId: type.id, recordCode: `${type.code}-${fy}` },
      newState: { leaveTypeId: type.id, fy, balancesClosed: closed },
      impact: { domains: ['hr'] },
    });
    processed += closed;
  }

  return { processed, notified: 0, skippedIdempotent: types.length - processed ? 0 : 0, errors: [] };
}

/** POST /compliance/labour/leave/:employmentId/encash. */
export async function encashLeave(employmentRelationshipId: string, input: { leaveTypeId: string; days: number }) {
  const auth = currentAuth();
  await assertEmploymentVisible('leave', employmentRelationshipId, 'edit');

  if (input.days <= 0) throw ApiError.badRequest('Encashment days must be a positive number.');

  const leaveType = await prisma.leaveType.findFirst({ where: { id: input.leaveTypeId, tenantId: auth.tenantId } });
  if (!leaveType) throw ApiError.notFound('Leave type');
  if (!leaveType.encashable) {
    throw ApiError.unprocessable(`${leaveType.name} is not marked encashable.`);
  }
  const maxDays = num(leaveType.maxEncashDays);
  if (maxDays !== null && input.days > maxDays) {
    throw ApiError.unprocessable(`${leaveType.name} may be encashed up to ${maxDays} days; ${input.days} was asked for.`);
  }

  const balance = await prisma.leaveBalance.findFirst({
    where: { tenantId: auth.tenantId, employmentRelationshipId, leaveTypeId: input.leaveTypeId },
  });
  const current = num(balance?.balanceDays) ?? 0;
  if (input.days > current) {
    throw ApiError.unprocessable(`Only ${current} days of ${leaveType.name} are available; ${input.days} was asked for.`);
  }
  if (!balance) throw ApiError.notFound('Leave balance');

  const basicPay = await basicPayFor(employmentRelationshipId);
  const amount = encashmentAmount(basicPay, input.days);

  const [txn, encashment] = await prisma.$transaction(async (tx) => {
    const t = await tx.leaveTransaction.create({
      data: {
        tenantId: auth.tenantId,
        leaveBalanceId: balance.id,
        txnType: 'encashment',
        amountDays: -input.days,
        note: `Encashed ${input.days} days of ${leaveType.name} at ₹${amount}, for payroll.`,
        createdById: auth.partyId,
      },
    });
    await recomputeLeaveBalance(tx, balance.id);
    const e = await tx.leaveEncashment.create({
      data: {
        tenantId: auth.tenantId,
        employmentRelationshipId,
        leaveTypeId: input.leaveTypeId,
        leaveTransactionId: t.id,
        days: input.days,
        amount,
        createdById: auth.partyId,
      },
    });
    return [t, e];
  });

  await auditWrite({ action: 'create', subjectType: 'leave_encashment', subjectId: encashment.id, after: encashment as never });
  await emit({
    name: 'kz.hr.leave_encashment.recorded',
    subject: { entityType: 'leave_encashment', entityId: encashment.id },
    newState: { days: input.days, amount, leaveTypeId: input.leaveTypeId },
    impact: { domains: ['hr'], materiality: { measure: 'leave_encashment', value: amount, currency: 'INR' } },
  });

  return { transaction: txn, encashment };
}

// ---------------------------------------------------------------------------
// Working hours and overtime
// ---------------------------------------------------------------------------

export async function listWorkingHoursRules() {
  const auth = currentAuth();
  await assertCan({ resource: 'holidays', verb: 'view' }); // hours caps ride the same labour-facing read grant
  return prisma.workingHoursRule.findMany({ where: { tenantId: auth.tenantId }, orderBy: { effectiveFrom: 'desc' } });
}

export async function createWorkingHoursRule(input: {
  effectiveFrom: Date;
  dailyCapHours: number;
  weeklyCapHours: number;
  spreadOverHours: number;
  otMultiplier: number;
  otCapPerQuarterHours: number;
  confirmed?: boolean;
  note?: string | null;
}) {
  const auth = currentAuth();
  await assertCan({ resource: 'holidays', verb: 'create' });
  const row = await prisma.workingHoursRule.create({
    data: { tenantId: auth.tenantId, confirmed: input.confirmed ?? false, ...input, note: input.note ?? null },
  });
  await auditWrite({ action: 'create', subjectType: 'working_hours_rule', subjectId: row.id, after: row as never });
  return row;
}

async function currentHoursRule(tenantId: string, asOf: Date) {
  return prisma.workingHoursRule.findFirst({
    where: { tenantId, effectiveFrom: { lte: asOf } },
    orderBy: { effectiveFrom: 'desc' },
  });
}

/**
 * The weekly job (Monday 02:00): sums last week's `WorkAttendance` per
 * employment, raises `CMP_LAB_HOURS_BREACH` once per employee per week when
 * the total crosses the weekly cap, and posts an `OvertimeAccrual` row for
 * whatever overtime was actually logged, breach or not — overtime pay is
 * owed for the hours worked, not only for the weeks that breach the cap.
 */
export async function runWeeklyHoursCheck(): Promise<JobResult> {
  const auth = currentAuth();
  const now = new Date();
  const lastWeekAnchor = new Date(now.getTime() - 7 * 86_400_000);
  const week = isoWeekLabel(lastWeekAnchor);
  const { start, end } = isoWeekRange(week);
  const endExclusive = new Date(end.getTime() + 86_400_000);

  const rule = await currentHoursRule(auth.tenantId, end);
  const weeklyCap = num(rule?.weeklyCapHours) ?? 48;
  const otMultiplier = num(rule?.otMultiplier) ?? 2;

  const employments = await prisma.employmentRelationship.findMany({
    where: { tenantId: auth.tenantId, status: { in: ['Active', 'OnLeave', 'NoticePeriod'] } },
    select: { id: true },
  });

  let processed = 0;
  let notified = 0;
  for (const employment of employments) {
    const attendance = await prisma.workAttendance.aggregate({
      where: { tenantId: auth.tenantId, employmentRelationshipId: employment.id, workDate: { gte: start, lt: endExclusive } },
      _sum: { workedMinutes: true, overtimeMinutes: true },
    });
    const workedMinutes = attendance._sum.workedMinutes ?? 0;
    const otMinutes = attendance._sum.overtimeMinutes ?? 0;
    const totalHours = (workedMinutes + otMinutes) / 60;
    const otHours = otMinutes / 60;
    if (totalHours === 0) continue;
    processed += 1;

    if (otHours > 0) {
      const basicPay = await basicPayFor(employment.id, end);
      const amount = overtimeAmount(basicPay, otHours, otMultiplier);
      await prisma.overtimeAccrual.upsert({
        where: { tenantId_employmentRelationshipId_isoWeek: { tenantId: auth.tenantId, employmentRelationshipId: employment.id, isoWeek: week } },
        create: {
          tenantId: auth.tenantId,
          employmentRelationshipId: employment.id,
          isoWeek: week,
          hours: otHours,
          rate: (basicPay / (26 * 8)) * otMultiplier,
          amount,
        },
        update: { hours: otHours, amount, computedAt: new Date() },
      });
    }

    if (totalHours > weeklyCap) {
      await raiseException({
        code: 'CMP_LAB_HOURS_BREACH',
        label: 'Weekly working hours exceeded',
        severity: 'S2_WARNING',
        subjectType: 'employment_relationship',
        subjectId: employment.id,
        domain: 'hr',
        detail: `${totalHours.toFixed(1)} hours logged in ${week} against a ${weeklyCap}-hour weekly cap. Payroll has not posted overtime silently — it needs a decision.`,
        ownerPartyId: await hrOpsOwnerId(auth.tenantId),
        triggerFingerprint: `hours_breach:${employment.id}:${week}`,
        ladderRung: 1,
      });
      notified += 1;
    }
  }

  return { processed, notified, skippedIdempotent: 0, errors: [] };
}

export async function overtimeAccruals(employmentRelationshipId: string) {
  await assertEmploymentVisible('attendance', employmentRelationshipId);
  const auth = currentAuth();
  return prisma.overtimeAccrual.findMany({
    where: { tenantId: auth.tenantId, employmentRelationshipId },
    orderBy: { isoWeek: 'desc' },
  });
}

// ---------------------------------------------------------------------------
// Statutory registers
// ---------------------------------------------------------------------------

export interface RegisterExport {
  filename: string;
  csv: string;
}

export async function registerWages(period: string): Promise<RegisterExport> {
  const auth = currentAuth();
  await assertCan({ resource: 'statutory_registers', verb: 'export' });
  const rows = await prisma.payrollInstruction.findMany({
    where: { tenantId: auth.tenantId, payPeriod: period },
    include: { employmentRelationship: { include: { person: true } } },
    orderBy: { createdAt: 'asc' },
  });
  const csv = toCsv(
    ['Employee', 'Designation', 'Gross', 'PF Employee', 'PF Employer', 'ESI Employee', 'ESI Employer', 'PT', 'Deductions', 'Net'],
    rows.map((r) => [
      r.employmentRelationship.person.fullName,
      r.employmentRelationship.legalEntity,
      num(r.grossAmount),
      num(r.pfEmployee),
      num(r.pfEmployer),
      num(r.esiEmployee),
      num(r.esiEmployer),
      num(r.professionalTax),
      num(r.deductions),
      num(r.netAmount),
    ]),
  );
  await auditExport('payroll_instruction', `wages:${period}`, rows.length);
  return { filename: `${REGISTER_NAMES.wages} - ${period}.csv`, csv };
}

export async function registerLeave(fy: string): Promise<RegisterExport> {
  const auth = currentAuth();
  await assertCan({ resource: 'statutory_registers', verb: 'export' });
  const balances = await prisma.leaveBalance.findMany({
    where: { tenantId: auth.tenantId },
    include: { leaveType: true, employmentRelationship: { include: { person: true } } },
  });
  const csv = toCsv(
    ['Employee', 'Leave Type', 'Balance Days', 'Held Days'],
    balances.map((b) => [b.employmentRelationship.person.fullName, b.leaveType.name, num(b.balanceDays), num(b.heldDays)]),
  );
  await auditExport('leave_balance', `leave:${fy}`, balances.length);
  return { filename: `${REGISTER_NAMES.leave} - ${fy}.csv`, csv };
}

export async function registerMusterRoll(period: string): Promise<RegisterExport> {
  const auth = currentAuth();
  await assertCan({ resource: 'statutory_registers', verb: 'export' });
  const [year, month] = period.split('-').map(Number);
  const from = new Date(Date.UTC(year, month - 1, 1));
  const to = new Date(Date.UTC(year, month, 1));
  const rows = await prisma.workAttendance.findMany({
    where: { tenantId: auth.tenantId, workDate: { gte: from, lt: to } },
    include: { employmentRelationship: { include: { person: true } } },
    orderBy: [{ employmentRelationshipId: 'asc' }, { workDate: 'asc' }],
  });
  const csv = toCsv(
    ['Employee', 'Date', 'Worked Minutes', 'Overtime Minutes', 'Status'],
    rows.map((r) => [r.employmentRelationship.person.fullName, ymd(r.workDate), r.workedMinutes, r.overtimeMinutes, r.status]),
  );
  await auditExport('work_attendance', `muster-roll:${period}`, rows.length);
  return { filename: `${REGISTER_NAMES['muster-roll']} - ${period}.csv`, csv };
}

export async function registerEmployees(): Promise<RegisterExport> {
  const auth = currentAuth();
  await assertCan({ resource: 'statutory_registers', verb: 'export' });
  const rows = await prisma.employmentRelationship.findMany({
    where: { tenantId: auth.tenantId },
    include: { person: true, assignments: { where: { rowStatus: 'Effective' }, include: { position: { include: { job: true } } }, take: 1 } },
    orderBy: { hireEffectiveDate: 'asc' },
  });
  const csv = toCsv(
    ["Name", "Father's Name", 'Date of Birth', 'Date of Joining', 'Designation', 'Engagement Type'],
    rows.map((r) => [
      r.person.fullName,
      // Not carried by this platform — a blank cell, not a guess.
      '',
      '',
      ymd(r.hireEffectiveDate),
      r.assignments[0]?.position.job.title ?? '',
      r.engagementType,
    ]),
  );
  await auditExport('employment_relationship', 'employees', rows.length);
  return { filename: `${REGISTER_NAMES.employees}.csv`, csv };
}

// ---------------------------------------------------------------------------
// POSH — Internal Committee
// ---------------------------------------------------------------------------

export async function listIccMembers() {
  const auth = currentAuth();
  await assertCan({ resource: 'posh_cases', verb: 'view' });
  return prisma.internalCommitteeMember.findMany({ where: { tenantId: auth.tenantId }, orderBy: { appointedOn: 'asc' } });
}

export async function appointIccMember(input: {
  personId?: string | null;
  externalName?: string | null;
  role: string;
  isWoman: boolean;
  appointedOn: Date;
  termEnds?: Date | null;
}) {
  const auth = currentAuth();
  await assertCan({ resource: 'posh_cases', verb: 'create' });
  if (!input.personId && !input.externalName) {
    throw ApiError.badRequest('A committee member needs either a personId or an external name.');
  }
  if (!['presiding', 'member', 'external'].includes(input.role)) {
    throw ApiError.badRequest(`"${input.role}" is not a committee role. Expected presiding, member or external.`);
  }
  const row = await prisma.internalCommitteeMember.create({
    data: {
      tenantId: auth.tenantId,
      personId: input.personId ?? null,
      externalName: input.externalName ?? null,
      role: input.role,
      isWoman: input.isWoman,
      appointedOn: input.appointedOn,
      termEnds: input.termEnds ?? null,
    },
  });
  await auditWrite({ action: 'create', subjectType: 'icc_member', subjectId: row.id, after: row as never });
  return row;
}

export async function endIccMemberTerm(id: string, termEnds: Date) {
  const auth = currentAuth();
  await assertCan({ resource: 'posh_cases', verb: 'edit' });
  const row = await prisma.internalCommitteeMember.findFirst({ where: { id, tenantId: auth.tenantId } });
  if (!row) throw ApiError.notFound('Committee member');
  const updated = await prisma.internalCommitteeMember.update({ where: { id }, data: { termEnds } });
  await auditWrite({ action: 'update', subjectType: 'icc_member', subjectId: id, before: row as never, after: updated as never });
  return updated;
}

/** POST /posh/committee/validate. */
export async function validateCommittee() {
  const auth = currentAuth();
  await assertCan({ resource: 'posh_cases', verb: 'view' });
  const members = await prisma.internalCommitteeMember.findMany({ where: { tenantId: auth.tenantId } });
  const now = new Date();
  const facts: IccMemberFact[] = members.map((m) => ({
    role: m.role as IccMemberFact['role'],
    isWoman: m.isWoman,
    termEnded: Boolean(m.termEnds && m.termEnds < now),
  }));
  return validateIccComposition(facts);
}

// ---------------------------------------------------------------------------
// POSH — Complaints
// ---------------------------------------------------------------------------

async function nextLabourNumber(entity: string): Promise<string> {
  const auth = currentAuth();
  const year = new Date().getUTCFullYear();
  const row = await prisma.recordSequence.upsert({
    where: { tenantId_entityType_year: { tenantId: auth.tenantId, entityType: `LAB:${entity}`, year } },
    create: { tenantId: auth.tenantId, entityType: `LAB:${entity}`, year, nextSequence: 2 },
    update: { nextSequence: { increment: 1 } },
    select: { nextSequence: true },
  });
  return `${entity}-${year}-${String(row.nextSequence - 1).padStart(4, '0')}`;
}

export async function listPoshComplaints() {
  const auth = currentAuth();
  // Case data, deliberately not folded into any other listing or count —
  // reaching it takes the grant, never an inference from a wider view.
  await assertCan({ resource: 'posh_cases', verb: 'view' });
  return prisma.poshComplaint.findMany({ where: { tenantId: auth.tenantId }, orderBy: { receivedOn: 'desc' } });
}

export async function createPoshComplaint(input: {
  complainantPersonId?: string | null;
  complainantText?: string | null;
  respondentPersonId?: string | null;
  respondentText?: string | null;
  receivedOn: Date;
}) {
  const auth = currentAuth();
  await assertCan({ resource: 'posh_cases', verb: 'create' });
  const number = await nextLabourNumber('POSH');
  const row = await prisma.poshComplaint.create({
    data: {
      tenantId: auth.tenantId,
      number,
      complainantPersonId: input.complainantPersonId ?? null,
      complainantText: input.complainantText ?? null,
      respondentPersonId: input.respondentPersonId ?? null,
      respondentText: input.respondentText ?? null,
      receivedOn: input.receivedOn,
      inquiryDueAt: computeInquiryDueAt(input.receivedOn),
    },
  });
  await auditWrite({ action: 'create', subjectType: 'posh_complaint', subjectId: row.id, after: { number, status: row.status } });
  await emit({
    name: 'kz.hr.posh_complaint.received',
    subject: { entityType: 'posh_complaint', entityId: row.id, recordCode: number },
    newState: { status: 'received' },
    confidentiality: 'restricted',
    impact: { domains: ['hr'] },
  });
  return row;
}

const POSH_STATUSES = ['received', 'inquiry', 'report_submitted', 'closed', 'withdrawn'] as const;

export async function transitionPoshComplaint(
  id: string,
  status: (typeof POSH_STATUSES)[number],
  input: { findings?: string; action?: string } = {},
) {
  const auth = currentAuth();
  await assertCan({ resource: 'posh_cases', verb: 'edit' });
  if (!POSH_STATUSES.includes(status)) throw ApiError.badRequest(`"${status}" is not a POSH complaint status.`);

  const row = await prisma.poshComplaint.findFirst({ where: { id, tenantId: auth.tenantId } });
  if (!row) throw ApiError.notFound('POSH complaint');

  const data: Record<string, unknown> = { status };
  if (status === 'report_submitted' && !row.inquiryClosedAt) {
    data.inquiryClosedAt = new Date();
    data.reportDueAt = computeReportDueAt(new Date());
  }
  if (input.findings !== undefined) data.findings = input.findings;
  if (input.action !== undefined) data.action = input.action;

  const updated = await prisma.poshComplaint.update({ where: { id }, data });
  await auditWrite({
    action: 'update',
    subjectType: 'posh_complaint',
    subjectId: id,
    before: { status: row.status },
    after: { status: updated.status },
  });
  return updated;
}

/** Daily job — CMP-LAB-001: the inquiry deadline fires an exception if unclosed at 90 days. */
export async function runPoshOverdueCheck(): Promise<JobResult> {
  const auth = currentAuth();
  const overdue = await prisma.poshComplaint.findMany({
    where: {
      tenantId: auth.tenantId,
      status: { notIn: ['closed', 'withdrawn'] },
      inquiryDueAt: { lt: new Date() },
    },
  });

  for (const complaint of overdue) {
    await raiseException({
      code: 'CMP_POSH_INQUIRY_OVERDUE',
      label: 'POSH inquiry overdue',
      severity: 'S3_HIGH_RISK',
      subjectType: 'posh_complaint',
      subjectId: complaint.id,
      subjectLabel: complaint.number,
      domain: 'hr',
      detail: `Inquiry due ${complaint.inquiryDueAt.toISOString().slice(0, 10)} (POSH Act Sec 11(4)) and the complaint is still ${complaint.status}.`,
      ownerPartyId: await hrOpsOwnerId(auth.tenantId),
      triggerFingerprint: `posh_overdue:${complaint.id}`,
      ladderRung: 1,
    });
  }
  return { processed: overdue.length, notified: overdue.length, skippedIdempotent: 0, errors: [] };
}

// ---------------------------------------------------------------------------
// POSH — Workshops and the annual report
// ---------------------------------------------------------------------------

export async function createPoshWorkshop(input: { heldOn: Date; topic: string; attendeeCount: number; note?: string | null }) {
  const auth = currentAuth();
  await assertCan({ resource: 'posh_cases', verb: 'create' });
  return prisma.poshWorkshop.create({
    data: { tenantId: auth.tenantId, heldOn: input.heldOn, topic: input.topic, attendeeCount: input.attendeeCount, note: input.note ?? null },
  });
}

export async function listPoshWorkshops() {
  const auth = currentAuth();
  await assertCan({ resource: 'posh_cases', verb: 'view' });
  return prisma.poshWorkshop.findMany({ where: { tenantId: auth.tenantId }, orderBy: { heldOn: 'desc' } });
}

/** GET /posh/annual-report/:year — POSH Act Sec 21. Prepares if not already computed for the year. */
export async function poshAnnualReport(year: number) {
  const auth = currentAuth();
  await assertCan({ resource: 'posh_cases', verb: 'view' });

  const from = new Date(Date.UTC(year, 0, 1));
  const to = new Date(Date.UTC(year + 1, 0, 1));
  const ninetyDaysAgo = new Date(Date.now() - 90 * 86_400_000);

  const [received, disposed, pendingOver90, workshops] = await Promise.all([
    prisma.poshComplaint.count({ where: { tenantId: auth.tenantId, receivedOn: { gte: from, lt: to } } }),
    prisma.poshComplaint.count({
      where: { tenantId: auth.tenantId, receivedOn: { gte: from, lt: to }, status: { in: ['closed', 'withdrawn'] } },
    }),
    prisma.poshComplaint.count({
      where: {
        tenantId: auth.tenantId,
        receivedOn: { gte: from, lt: to < ninetyDaysAgo ? to : ninetyDaysAgo },
        status: { notIn: ['closed', 'withdrawn'] },
      },
    }),
    prisma.poshWorkshop.count({ where: { tenantId: auth.tenantId, heldOn: { gte: from, lt: to } } }),
  ]);

  const snapshot = { year, received, disposed, pending: received - disposed, pendingOver90Days: pendingOver90, workshopsHeld: workshops };

  const existing = await prisma.poshAnnualReport.findUnique({ where: { tenantId_year: { tenantId: auth.tenantId, year } } });
  if (existing?.status === 'filed') return existing; // filed is final — never recomputed under the same id.

  const row = await prisma.poshAnnualReport.upsert({
    where: { tenantId_year: { tenantId: auth.tenantId, year } },
    create: { tenantId: auth.tenantId, year, snapshot: snapshot as never, preparedById: auth.partyId },
    update: { snapshot: snapshot as never, preparedAt: new Date(), preparedById: auth.partyId },
  });
  await auditWrite({ action: existing ? 'update' : 'create', subjectType: 'posh_annual_report', subjectId: row.id, after: snapshot as never });
  return row;
}

export async function markPoshAnnualReportFiled(year: number) {
  const auth = currentAuth();
  await assertCan({ resource: 'posh_cases', verb: 'edit' });
  const row = await prisma.poshAnnualReport.findUnique({ where: { tenantId_year: { tenantId: auth.tenantId, year } } });
  if (!row) throw ApiError.notFound('POSH annual report');
  const updated = await prisma.poshAnnualReport.update({ where: { id: row.id }, data: { status: 'filed', filedAt: new Date(), filedById: auth.partyId } });
  await auditWrite({ action: 'update', subjectType: 'posh_annual_report', subjectId: row.id, before: { status: row.status }, after: { status: 'filed' } });
  return updated;
}

// ---------------------------------------------------------------------------
// Disciplinary process
// ---------------------------------------------------------------------------

export async function listDisciplinaryCases(employmentRelationshipId?: string) {
  const auth = currentAuth();
  await assertCan({ resource: 'disciplinary_cases', verb: 'view' });
  return prisma.disciplinaryCase.findMany({
    where: { tenantId: auth.tenantId, ...(employmentRelationshipId ? { employmentRelationshipId } : {}) },
    orderBy: { showCauseIssuedAt: 'desc' },
  });
}

export async function openDisciplinaryCase(input: { employmentRelationshipId: string; showCauseIssuedAt?: Date; note: string }) {
  const auth = currentAuth();
  await assertCan({ resource: 'disciplinary_cases', verb: 'create' });

  const employment = await prisma.employmentRelationship.findFirst({
    where: { id: input.employmentRelationshipId, tenantId: auth.tenantId },
  });
  if (!employment) throw ApiError.notFound('Employment relationship');

  const showCauseIssuedAt = input.showCauseIssuedAt ?? new Date();
  const row = await prisma.disciplinaryCase.create({
    data: {
      tenantId: auth.tenantId,
      employmentRelationshipId: input.employmentRelationshipId,
      showCauseIssuedAt,
      replyDueAt: computeReplyDueAt(showCauseIssuedAt),
    },
  });

  const { recordEvidence } = await import('../performance.js');
  await recordEvidence({
    employmentRelationshipId: input.employmentRelationshipId,
    kind: 'corrective_note',
    description: input.note,
    caseScoped: true,
    caseRef: row.id,
  });

  await auditWrite({ action: 'create', subjectType: 'disciplinary_case', subjectId: row.id, after: { status: row.status } });
  await emit({
    name: 'kz.hr.disciplinary_case.opened',
    subject: { entityType: 'disciplinary_case', entityId: row.id },
    newState: { status: 'show_cause' },
    owner: { partyId: employment.personId },
    confidentiality: 'restricted',
    impact: { domains: ['hr'] },
  });
  return row;
}

export async function advanceDisciplinaryCase(
  id: string,
  input: {
    event: 'reply' | 'inquiry' | 'decision' | 'close';
    note: string;
    inquiryOfficer?: string;
    decision?: string;
    outcome?: 'warning' | 'suspension' | 'termination' | 'none';
  },
) {
  const auth = currentAuth();
  await assertCan({ resource: 'disciplinary_cases', verb: 'edit' });

  const row = await prisma.disciplinaryCase.findFirst({ where: { id, tenantId: auth.tenantId } });
  if (!row) throw ApiError.notFound('Disciplinary case');

  const data: Record<string, unknown> = {};
  let terminationNote: string | null = null;

  switch (input.event) {
    case 'reply':
      if (row.status !== 'show_cause') throw ApiError.unprocessable(`Case is ${row.status}, not awaiting a reply.`);
      data.status = 'reply_received';
      data.replyReceivedAt = new Date();
      break;
    case 'inquiry':
      if (!['show_cause', 'reply_received'].includes(row.status)) throw ApiError.unprocessable(`Case is ${row.status}; an inquiry cannot open from there.`);
      data.status = 'inquiry';
      data.inquiryOfficer = input.inquiryOfficer ?? null;
      data.inquiryStartedAt = new Date();
      break;
    case 'decision':
      if (row.status !== 'inquiry') throw ApiError.unprocessable(`Case is ${row.status}; a decision follows an inquiry.`);
      data.status = 'decision';
      data.decision = input.decision ?? null;
      data.decidedAt = new Date();
      data.outcome = input.outcome ?? 'none';
      break;
    case 'close':
      if (row.status !== 'decision') throw ApiError.unprocessable(`Case is ${row.status}; only a decided case is closed.`);
      data.status = 'closed';
      data.closedAt = new Date();
      if (row.outcome === 'termination') terminationNote = 'Disciplinary decision: termination.';
      break;
    default:
      throw ApiError.badRequest(`"${input.event}" is not a step in the disciplinary process.`);
  }

  const updated = await prisma.disciplinaryCase.update({ where: { id }, data });

  const { recordEvidence } = await import('../performance.js');
  await recordEvidence({
    employmentRelationshipId: row.employmentRelationshipId,
    kind: 'corrective_note',
    description: input.note,
    caseScoped: true,
    caseRef: row.id,
  });

  await auditWrite({
    action: 'update',
    subjectType: 'disciplinary_case',
    subjectId: id,
    before: { status: row.status },
    after: { status: updated.status, outcome: updated.outcome },
  });

  // Termination goes through the employment lifecycle itself, never a status
  // flip here — this case records the "why", employment.ts owns the "what".
  let terminationApplied = false;
  let terminationMessage: string | null = null;
  if (terminationNote) {
    try {
      const { transitionEmployment } = await import('../employment.js');
      await transitionEmployment(row.employmentRelationshipId, 'TERMINATE_POST_DISCIPLINARY', {
        note: `${terminationNote} Case ${row.id}.`,
      });
      terminationApplied = true;
    } catch (err) {
      terminationMessage =
        `The disciplinary outcome is termination, but the employment relationship could not be moved automatically ` +
        `(${err instanceof Error ? err.message : String(err)}). HR must apply the transition by hand.`;
    }
  }

  return { case: updated, terminationApplied, terminationMessage };
}

// ---------------------------------------------------------------------------
// Letters
// ---------------------------------------------------------------------------

interface IssueLetterInput {
  kind: HrLetterKind;
  employmentRelationshipId?: string | null;
  applicationId?: string | null;
  employeeName: string;
  legalEntity: string;
  designation?: string | null;
  hireEffectiveDate?: Date | null;
  lastWorkingDay?: Date | null;
  separationType?: string | null;
}

/** Issues a letter as a final document — a correction is a new letter referencing the old, never an edit. */
export async function issueLetter(input: IssueLetterInput) {
  const auth = currentAuth();
  const number = await nextLabourNumber('LTR');
  const issuedOn = new Date().toISOString().slice(0, 10);
  const facts = {
    employeeName: input.employeeName,
    designation: input.designation ?? null,
    legalEntity: input.legalEntity,
    hireEffectiveDate: input.hireEffectiveDate ? input.hireEffectiveDate.toISOString().slice(0, 10) : null,
    lastWorkingDay: input.lastWorkingDay ? input.lastWorkingDay.toISOString().slice(0, 10) : null,
    separationType: input.separationType ?? null,
    issuedOn,
    number,
  };
  const body = buildLetterBody(input.kind, facts);

  const row = await prisma.hrLetter.create({
    data: {
      tenantId: auth.tenantId,
      kind: input.kind,
      employmentRelationshipId: input.employmentRelationshipId ?? null,
      applicationId: input.applicationId ?? null,
      number,
      snapshot: { ...facts, body } as never,
      issuedById: auth.partyId,
    },
  });

  await auditWrite({ action: 'create', subjectType: 'hr_letter', subjectId: row.id, after: { kind: input.kind, number } });
  await emit({
    name: 'kz.hr.hr_letter.issued',
    subject: { entityType: 'hr_letter', entityId: row.id, recordCode: number },
    newState: { kind: input.kind },
    impact: { domains: ['hr'] },
  });
  return row;
}

export async function listLetters(filter: { employmentRelationshipId?: string; applicationId?: string } = {}) {
  const auth = currentAuth();
  await assertCan({ resource: 'hr_letters', verb: 'view' });
  return prisma.hrLetter.findMany({
    where: {
      tenantId: auth.tenantId,
      ...(filter.employmentRelationshipId ? { employmentRelationshipId: filter.employmentRelationshipId } : {}),
      ...(filter.applicationId ? { applicationId: filter.applicationId } : {}),
    },
    orderBy: { issuedAt: 'desc' },
  });
}

/** GET /letters/:id/document. */
export async function letterDocument(id: string) {
  const auth = currentAuth();
  await assertCan({ resource: 'hr_letters', verb: 'view' });
  const row = await prisma.hrLetter.findFirst({ where: { id, tenantId: auth.tenantId } });
  if (!row) throw ApiError.notFound('Letter');
  return row;
}

// ---------------------------------------------------------------------------
// Consents
// ---------------------------------------------------------------------------

export async function recordBgvConsent(employmentRelationshipId: string) {
  const auth = currentAuth();
  await assertEmploymentVisible('employees', employmentRelationshipId, 'edit');
  const before = await prisma.employmentRelationship.findFirst({ where: { id: employmentRelationshipId, tenantId: auth.tenantId } });
  const row = await prisma.employmentRelationship.update({
    where: { id: employmentRelationshipId },
    data: { backgroundVerificationConsentAt: new Date() },
  });
  await auditWrite({
    action: 'update',
    subjectType: 'employment_relationship',
    subjectId: employmentRelationshipId,
    before: { backgroundVerificationConsentAt: before?.backgroundVerificationConsentAt ?? null },
    after: { backgroundVerificationConsentAt: row.backgroundVerificationConsentAt },
    force: true,
  });
  return { backgroundVerificationConsentAt: row.backgroundVerificationConsentAt };
}

export async function recordCodeOfConductAck(employmentRelationshipId: string) {
  const auth = currentAuth();
  await assertEmploymentVisible('employees', employmentRelationshipId, 'edit');
  const before = await prisma.employmentRelationship.findFirst({ where: { id: employmentRelationshipId, tenantId: auth.tenantId } });
  const row = await prisma.employmentRelationship.update({
    where: { id: employmentRelationshipId },
    data: { codeOfConductAcknowledgedAt: new Date() },
  });
  await auditWrite({
    action: 'update',
    subjectType: 'employment_relationship',
    subjectId: employmentRelationshipId,
    before: { codeOfConductAcknowledgedAt: before?.codeOfConductAcknowledgedAt ?? null },
    after: { codeOfConductAcknowledgedAt: row.codeOfConductAcknowledgedAt },
    force: true,
  });
  return { codeOfConductAcknowledgedAt: row.codeOfConductAcknowledgedAt };
}

// ---------------------------------------------------------------------------
// Offboarding hook — relieving/experience letters, Form 10C/19 checklist
// ---------------------------------------------------------------------------

export async function handleOffboardingCompleted(payload: {
  offboarding: { id: string; checklist: unknown; employmentRelationshipId: string };
  employmentRelationship: { id: string; personId: string; legalEntity: string; hireEffectiveDate: Date; separationDate: Date | null; separationType: string | null };
}) {
  const { offboarding, employmentRelationship } = payload;
  const auth = currentAuth();

  const person = await prisma.person.findFirst({ where: { id: employmentRelationship.personId, tenantId: auth.tenantId } });
  const assignment = await prisma.assignment.findFirst({
    where: { tenantId: auth.tenantId, employmentRelationshipId: employmentRelationship.id },
    include: { position: { include: { job: true } } },
    orderBy: { createdAt: 'desc' },
  });

  const relieving = await issueLetter({
    kind: 'relieving',
    employmentRelationshipId: employmentRelationship.id,
    employeeName: person?.fullName ?? 'Employee',
    legalEntity: employmentRelationship.legalEntity,
    designation: assignment?.position.job.title ?? null,
    lastWorkingDay: employmentRelationship.separationDate,
    separationType: employmentRelationship.separationType,
  });

  await issueLetter({
    kind: 'experience',
    employmentRelationshipId: employmentRelationship.id,
    employeeName: person?.fullName ?? 'Employee',
    legalEntity: employmentRelationship.legalEntity,
    designation: assignment?.position.job.title ?? null,
    hireEffectiveDate: employmentRelationship.hireEffectiveDate,
    lastWorkingDay: employmentRelationship.separationDate,
  });

  const existingChecklist = Array.isArray(offboarding.checklist) ? (offboarding.checklist as unknown[]) : [];
  const checklist = [
    ...existingChecklist,
    { item: 'Form 10C (EPF pension withdrawal)', status: 'pending', addedAt: new Date().toISOString() },
    { item: 'Form 19 (PF final settlement)', status: 'pending', addedAt: new Date().toISOString() },
  ];

  await prisma.offboarding.update({
    where: { id: offboarding.id },
    data: { checklist: checklist as never, relievingLetterDocumentId: relieving.id },
  });
}

registerHook('offboarding.completed', 'cmp_labour', (payload) =>
  handleOffboardingCompleted(payload as Parameters<typeof handleOffboardingCompleted>[0]),
);
