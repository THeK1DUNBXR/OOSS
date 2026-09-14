/**
 * HCM — G2. Time (docs/hcm/time.md).
 *
 * Shifts, roster assignments, clock in/out, weekly timesheets, overtime
 * pre-approval, comp-off, and attendance regularisation. Regularisation
 * drives the existing `WorkAttendance` machine in `domains/leave.ts` rather
 * than re-implementing DISPUTE/REGULARISE here.
 */

import {
  classifyPunch,
  compOffDaysForHours,
  compOffExpiryDate,
  EVENTS,
  parseHHMM,
  weekStartMonday,
  weeklyHoursTotal,
  type ShiftDef,
  type Verb,
} from '@kaizen/shared';
import { prisma, num } from '../../platform/db.js';
import { currentAuth } from '../../platform/context.js';
import { emit } from '../../platform/eventBus.js';
import { nextRecordCode } from '../../platform/recordCode.js';
import { ApiError } from '../../platform/errors.js';
import { assertCan, scopeFor } from '../../platform/permissions.js';
import { assertEmploymentVisible } from '../../platform/recordScope.js';
import { auditWrite, registerGovernedEntities } from '../../platform/audit.js';
import { raiseException } from '../../platform/exceptions.js';
import { transitionAttendance } from '../leave.js';
import type { JobResult } from '../../jobs/scheduler.js';

registerGovernedEntities('hcm_time', [
  'shift', 'roster_assignment', 'clock_event', 'timesheet', 'timesheet_entry',
  'overtime_request', 'comp_off', 'attendance_regularisation',
]);

function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function dayStart(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

/** The active employment behind the calling user's own account — what every `/me` endpoint resolves against. */
export async function myEmploymentId(): Promise<string> {
  const auth = currentAuth();
  if (!auth.partyId) throw ApiError.unprocessable('No person is attached to this account.');
  const employment = await prisma.employmentRelationship.findFirst({
    where: { tenantId: auth.tenantId, personId: auth.partyId, deletedAt: null, status: { notIn: ['OfferRescinded', 'NoShow'] } },
    orderBy: { hireEffectiveDate: 'desc' },
    select: { id: true },
  });
  if (!employment) throw ApiError.unprocessable('No employment record is attached to this account.');
  return employment.id;
}

/**
 * The WHERE fragment a list query needs for `own` scope on a table that
 * stores a plain `employmentRelationshipId` string rather than a Prisma
 * relation to it (docs/plan/hcm.md rule 8) — `recordScope.ts`'s own
 * `employmentVisibilityWhere` assumes a relation field, which these tables
 * deliberately do not have.
 */
async function ownScopeWhere(resource: string, verb: Verb = 'view'): Promise<Record<string, unknown>> {
  const scope = await scopeFor(resource, verb);
  if (scope === 'all') return {};
  const auth = currentAuth();
  const employment = await prisma.employmentRelationship.findFirst({
    where: { tenantId: auth.tenantId, personId: auth.partyId ?? '', deletedAt: null },
    select: { id: true },
  });
  // No employment on this account and an own-only scope: the list is empty,
  // not unfiltered — an impossible id rather than an omitted clause.
  return { employmentRelationshipId: employment?.id ?? '__none__' };
}

function selfDealingCheck(requesterId: string | null, decidingPartyId: string | null) {
  if (requesterId && decidingPartyId && requesterId === decidingPartyId) {
    throw ApiError.forbidden(
      'The Self-Dealing Bar is unconditional: the person who raised this may never decide it themselves.',
      [{ axis: 'WHO', passed: false, reason: 'self_dealing_bar' }],
    );
  }
}

// ---------------------------------------------------------------------------
// Shifts
// ---------------------------------------------------------------------------

export async function listShifts(activeOnly = false) {
  const auth = currentAuth();
  await assertCan({ resource: 'shifts', verb: 'view' });
  return prisma.shift.findMany({
    where: { tenantId: auth.tenantId, ...(activeOnly ? { active: true } : {}) },
    orderBy: { name: 'asc' },
  });
}

function shiftDef(shift: { startTime: string; endTime: string; graceMinutes: number; breakMinutes: number; nightShift: boolean }): ShiftDef {
  return {
    startMinutes: parseHHMM(shift.startTime),
    endMinutes: parseHHMM(shift.endTime),
    graceMinutes: shift.graceMinutes,
    breakMinutes: shift.breakMinutes,
    nightShift: shift.nightShift,
  };
}

export async function createShift(input: {
  code: string;
  name: string;
  startTime: string;
  endTime: string;
  graceMinutes?: number;
  breakMinutes?: number;
  nightShift?: boolean;
}) {
  const auth = currentAuth();
  await assertCan({ resource: 'shifts', verb: 'create' });
  // Validated for shape even though the row stores the raw strings — a
  // malformed time should fail at creation, not the first time a punch tries
  // to classify against it.
  parseHHMM(input.startTime);
  parseHHMM(input.endTime);

  const row = await prisma.shift.create({
    data: {
      tenantId: auth.tenantId,
      code: input.code,
      name: input.name,
      startTime: input.startTime,
      endTime: input.endTime,
      graceMinutes: input.graceMinutes ?? 0,
      breakMinutes: input.breakMinutes ?? 0,
      nightShift: input.nightShift ?? false,
    },
  });
  await auditWrite({ action: 'create', subjectType: 'shift', subjectId: row.id, after: row as never });
  await emit({
    name: EVENTS.SHIFT_CREATED,
    subject: { entityType: 'shift', entityId: row.id },
    newState: { code: row.code, name: row.name },
    impact: { domains: ['hr'] },
  });
  return row;
}

export async function updateShift(id: string, patch: { name?: string; graceMinutes?: number; breakMinutes?: number; active?: boolean }) {
  const auth = currentAuth();
  await assertCan({ resource: 'shifts', verb: 'edit' });
  const existing = await prisma.shift.findFirst({ where: { id, tenantId: auth.tenantId } });
  if (!existing) throw ApiError.notFound('Shift');
  const row = await prisma.shift.update({ where: { id }, data: patch });
  await auditWrite({ action: 'update', subjectType: 'shift', subjectId: id, before: existing as never, after: row as never });
  return row;
}

// ---------------------------------------------------------------------------
// Roster
// ---------------------------------------------------------------------------

export async function listRosterAssignments(employmentRelationshipId?: string) {
  const auth = currentAuth();
  await assertCan({ resource: 'rosters', verb: 'view' });
  const where = employmentRelationshipId
    ? { tenantId: auth.tenantId, employmentRelationshipId }
    : { tenantId: auth.tenantId };
  return prisma.rosterAssignment.findMany({ where, orderBy: { effectiveFrom: 'desc' } });
}

export async function assignRoster(input: {
  employmentRelationshipId: string;
  shiftId: string;
  effectiveFrom: Date;
  effectiveTo?: Date | null;
  weeklyOffDays?: number[];
  note?: string | null;
}) {
  const auth = currentAuth();
  await assertCan({ resource: 'rosters', verb: 'create' });
  await assertEmploymentVisible('rosters', input.employmentRelationshipId);

  const shift = await prisma.shift.findFirst({ where: { id: input.shiftId, tenantId: auth.tenantId } });
  if (!shift) throw ApiError.notFound('Shift');

  const row = await prisma.rosterAssignment.create({
    data: {
      tenantId: auth.tenantId,
      employmentRelationshipId: input.employmentRelationshipId,
      shiftId: input.shiftId,
      effectiveFrom: dayStart(input.effectiveFrom),
      effectiveTo: input.effectiveTo ? dayStart(input.effectiveTo) : null,
      weeklyOffDays: input.weeklyOffDays ?? [0],
      note: input.note ?? null,
    },
  });
  await auditWrite({ action: 'create', subjectType: 'roster_assignment', subjectId: row.id, after: row as never });
  await emit({
    name: EVENTS.ROSTER_PUBLISHED,
    subject: { entityType: 'roster_assignment', entityId: row.id },
    related: [{ relation: 'assigns', entityType: 'employment_relationship', entityId: input.employmentRelationshipId }],
    newState: { shiftId: input.shiftId, effectiveFrom: ymd(row.effectiveFrom) },
    impact: { domains: ['hr'] },
  });
  return row;
}

/** The roster row covering `on` (default today) for one employment, or null if none is assigned. */
export async function rosterFor(employmentRelationshipId: string, on: Date = new Date()) {
  const auth = currentAuth();
  const day = dayStart(on);
  return prisma.rosterAssignment.findFirst({
    where: {
      tenantId: auth.tenantId,
      employmentRelationshipId,
      effectiveFrom: { lte: day },
      OR: [{ effectiveTo: null }, { effectiveTo: { gte: day } }],
    },
    orderBy: { effectiveFrom: 'desc' },
  });
}

// ---------------------------------------------------------------------------
// Clock events
// ---------------------------------------------------------------------------

export async function listClockEvents(employmentRelationshipId: string, from?: Date, to?: Date) {
  const auth = currentAuth();
  await assertEmploymentVisible('clock_events', employmentRelationshipId);
  return prisma.clockEvent.findMany({
    where: {
      tenantId: auth.tenantId,
      employmentRelationshipId,
      ...(from || to ? { occurredAt: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } } : {}),
    },
    orderBy: { occurredAt: 'asc' },
  });
}

async function lastOpenClock(employmentRelationshipId: string, tenantId: string) {
  const last = await prisma.clockEvent.findFirst({
    where: { tenantId, employmentRelationshipId },
    orderBy: { occurredAt: 'desc' },
  });
  return last;
}

/** Records one punch. `kind` is enforced to alternate — clocking in twice with no clock-out is refused rather than silently overwriting the open punch. */
export async function recordClockEvent(input: {
  employmentRelationshipId: string;
  kind: 'in' | 'out';
  occurredAt?: Date;
  source?: 'web' | 'mobile' | 'biometric_import';
  ip?: string | null;
  deviceId?: string | null;
  lat?: number | null;
  long?: number | null;
  note?: string | null;
}) {
  const auth = currentAuth();
  await assertCan({ resource: 'clock_events', verb: 'create' });
  await assertEmploymentVisible('clock_events', input.employmentRelationshipId);

  const last = await lastOpenClock(input.employmentRelationshipId, auth.tenantId);
  if (input.kind === 'in' && last?.kind === 'in') {
    throw ApiError.unprocessable('Already clocked in — clock out before clocking in again.');
  }
  if (input.kind === 'out' && (!last || last.kind === 'out')) {
    throw ApiError.unprocessable('No open clock-in to close. Clock in first.');
  }

  const row = await prisma.clockEvent.create({
    data: {
      tenantId: auth.tenantId,
      employmentRelationshipId: input.employmentRelationshipId,
      kind: input.kind,
      occurredAt: input.occurredAt ?? new Date(),
      source: input.source ?? 'web',
      ip: input.ip ?? null,
      deviceId: input.deviceId ?? null,
      lat: input.lat ?? null,
      long: input.long ?? null,
      note: input.note ?? null,
    },
  });

  await emit({
    name: EVENTS.CLOCK_EVENT_RECORDED,
    subject: { entityType: 'clock_event', entityId: row.id },
    related: [{ relation: 'punches', entityType: 'employment_relationship', entityId: input.employmentRelationshipId }],
    newState: { kind: row.kind, occurredAt: row.occurredAt.toISOString(), source: row.source },
    impact: { domains: ['hr'] },
  });

  return row;
}

// ---------------------------------------------------------------------------
// Nightly derivation: ClockEvent + roster -> WorkAttendance
// ---------------------------------------------------------------------------

/**
 * Folds yesterday's clock events into `WorkAttendance`, against the roster
 * shift in force that day. A day with no roster assignment is skipped
 * (nothing to classify against) rather than guessed at. Idempotent: it
 * upserts, so a second run on the same day recomputes rather than duplicates.
 */
export async function deriveAttendanceFromClockEvents(forDate: Date = new Date(Date.now() - 86_400_000)): Promise<JobResult> {
  const auth = currentAuth();
  const day = dayStart(forDate);
  const dayEnd = new Date(day.getTime() + 86_400_000);

  const events = await prisma.clockEvent.findMany({
    where: { tenantId: auth.tenantId, occurredAt: { gte: day, lt: dayEnd } },
    orderBy: { occurredAt: 'asc' },
  });

  const byEmployment = new Map<string, typeof events>();
  for (const e of events) {
    const list = byEmployment.get(e.employmentRelationshipId) ?? [];
    list.push(e);
    byEmployment.set(e.employmentRelationshipId, list);
  }

  let processed = 0;
  const errors: string[] = [];
  for (const [employmentRelationshipId, list] of byEmployment) {
    try {
      const roster = await rosterFor(employmentRelationshipId, day);
      if (!roster) continue; // No roster to classify against.
      const shift = await prisma.shift.findFirst({ where: { id: roster.shiftId, tenantId: auth.tenantId } });
      if (!shift) continue;

      const firstIn = list.find((e) => e.kind === 'in');
      const lastOut = [...list].reverse().find((e) => e.kind === 'out');
      const inMinutes = firstIn ? firstIn.occurredAt.getUTCHours() * 60 + firstIn.occurredAt.getUTCMinutes() : null;
      const outMinutes = lastOut ? lastOut.occurredAt.getUTCHours() * 60 + lastOut.occurredAt.getUTCMinutes() : null;

      const result = classifyPunch(shiftDef(shift), inMinutes, outMinutes);

      const existing = await prisma.workAttendance.findUnique({
        where: { employmentRelationshipId_workDate: { employmentRelationshipId, workDate: day } },
      });
      if (existing?.status === 'Locked') continue; // A locked day is closed to the deriver too.

      await prisma.workAttendance.upsert({
        where: { employmentRelationshipId_workDate: { employmentRelationshipId, workDate: day } },
        create: {
          tenantId: auth.tenantId,
          employmentRelationshipId,
          workDate: day,
          workedMinutes: result.workedMinutes,
          overtimeMinutes: result.overtimeMinutes,
          missingPunch: result.status === 'absent',
          note: `Derived from clock events: ${result.status}.`,
        },
        update: {
          workedMinutes: result.workedMinutes,
          overtimeMinutes: result.overtimeMinutes,
          missingPunch: result.status === 'absent',
          note: `Derived from clock events: ${result.status}.`,
        },
      });
      processed += 1;
    } catch (err) {
      errors.push(`${employmentRelationshipId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return { processed, notified: 0, skippedIdempotent: 0, errors };
}

// ---------------------------------------------------------------------------
// Timesheets
// ---------------------------------------------------------------------------

async function getOrCreateTimesheet(employmentRelationshipId: string, weekStart: Date) {
  const auth = currentAuth();
  const monday = weekStartMonday(weekStart);
  const existing = await prisma.timesheet.findUnique({
    where: { tenantId_employmentRelationshipId_weekStart: { tenantId: auth.tenantId, employmentRelationshipId, weekStart: monday } },
  });
  if (existing) return existing;

  const recordCode = await nextRecordCode('TSH');
  return prisma.timesheet.create({
    data: { tenantId: auth.tenantId, employmentRelationshipId, weekStart: monday, recordCode, status: 'draft' },
  });
}

export async function listTimesheets(employmentRelationshipId?: string) {
  const auth = currentAuth();
  await assertCan({ resource: 'timesheets', verb: 'view' });
  const scopeWhere = employmentRelationshipId ? {} : await ownScopeWhere('timesheets', 'view');
  return prisma.timesheet.findMany({
    where: { tenantId: auth.tenantId, ...(employmentRelationshipId ? { employmentRelationshipId } : {}), ...scopeWhere },
    orderBy: { weekStart: 'desc' },
  });
}

export async function getTimesheet(id: string) {
  const auth = currentAuth();
  await assertCan({ resource: 'timesheets', verb: 'view' });
  const row = await prisma.timesheet.findFirst({ where: { id, tenantId: auth.tenantId } });
  if (!row) throw ApiError.notFound('Timesheet');
  const scope = await scopeFor('timesheets', 'view');
  if (scope !== 'all') {
    const employment = await prisma.employmentRelationship.findFirst({ where: { id: row.employmentRelationshipId }, select: { personId: true } });
    if (employment?.personId !== auth.partyId) throw ApiError.notFound('Timesheet');
  }
  const entries = await prisma.timesheetEntry.findMany({ where: { tenantId: auth.tenantId, timesheetId: id }, orderBy: { date: 'asc' } });
  return { ...row, entries };
}

async function recomputeTimesheetTotal(tenantId: string, timesheetId: string) {
  const entries = await prisma.timesheetEntry.findMany({ where: { tenantId, timesheetId }, select: { hours: true } });
  const total = weeklyHoursTotal(entries.map((e) => num(e.hours) ?? 0));
  await prisma.timesheet.update({ where: { id: timesheetId }, data: { totalHours: total } });
  return total;
}

export async function addTimesheetEntry(input: {
  employmentRelationshipId: string;
  date: Date;
  projectId?: string | null;
  taskRef?: string | null;
  hours: number;
  billable?: boolean;
  note?: string | null;
}) {
  const auth = currentAuth();
  await assertCan({ resource: 'timesheets', verb: 'create' });
  await assertEmploymentVisible('timesheets', input.employmentRelationshipId);
  if (input.hours <= 0 || input.hours > 24) throw ApiError.badRequest('Hours for a single entry must be more than 0 and no more than 24.');

  const timesheet = await getOrCreateTimesheet(input.employmentRelationshipId, input.date);
  if (timesheet.status !== 'draft' && timesheet.status !== 'rejected') {
    throw ApiError.unprocessable(`This timesheet is ${timesheet.status} — it cannot be edited further.`);
  }

  const entry = await prisma.timesheetEntry.create({
    data: {
      tenantId: auth.tenantId,
      timesheetId: timesheet.id,
      date: dayStart(input.date),
      projectId: input.projectId ?? null,
      taskRef: input.taskRef ?? null,
      hours: input.hours,
      billable: input.billable ?? false,
      note: input.note ?? null,
    },
  });
  await recomputeTimesheetTotal(auth.tenantId, timesheet.id);
  return entry;
}

export async function removeTimesheetEntry(id: string) {
  const auth = currentAuth();
  await assertCan({ resource: 'timesheets', verb: 'edit' });
  const entry = await prisma.timesheetEntry.findFirst({ where: { id, tenantId: auth.tenantId } });
  if (!entry) throw ApiError.notFound('Timesheet entry');
  const timesheet = await prisma.timesheet.findFirst({ where: { id: entry.timesheetId, tenantId: auth.tenantId } });
  if (timesheet && timesheet.status !== 'draft' && timesheet.status !== 'rejected') {
    throw ApiError.unprocessable(`This timesheet is ${timesheet.status} — it cannot be edited further.`);
  }
  await prisma.timesheetEntry.delete({ where: { id } });
  if (timesheet) await recomputeTimesheetTotal(auth.tenantId, timesheet.id);
  return { deleted: true };
}

export async function submitTimesheet(id: string) {
  const auth = currentAuth();
  const row = await prisma.timesheet.findFirst({ where: { id, tenantId: auth.tenantId } });
  if (!row) throw ApiError.notFound('Timesheet');
  await assertEmploymentVisible('timesheets', row.employmentRelationshipId, 'edit');
  if (row.status !== 'draft' && row.status !== 'rejected') {
    throw ApiError.unprocessable(`Timesheet is ${row.status}; only a draft or rejected timesheet can be submitted.`);
  }
  const entryCount = await prisma.timesheetEntry.count({ where: { timesheetId: id } });
  if (entryCount === 0) throw ApiError.unprocessable('Add at least one entry before submitting.');

  const updated = await prisma.timesheet.update({ where: { id }, data: { status: 'submitted', submittedAt: new Date(), decisionNote: null } });
  await emit({
    name: EVENTS.TIMESHEET_SUBMITTED,
    subject: { entityType: 'timesheet', entityId: id, recordCode: row.recordCode },
    related: [{ relation: 'covers', entityType: 'employment_relationship', entityId: row.employmentRelationshipId }],
    newState: { status: 'submitted', totalHours: num(row.totalHours) },
    impact: { domains: ['hr'] },
  });
  return updated;
}

async function decideTimesheet(id: string, approve: boolean, note: string | null) {
  const auth = currentAuth();
  const row = await prisma.timesheet.findFirst({ where: { id, tenantId: auth.tenantId } });
  if (!row) throw ApiError.notFound('Timesheet');
  await assertCan({ resource: 'timesheets', verb: 'approve' });

  const employment = await prisma.employmentRelationship.findFirst({ where: { id: row.employmentRelationshipId }, select: { personId: true } });
  selfDealingCheck(employment?.personId ?? null, auth.partyId);

  if (row.status !== 'submitted') throw ApiError.unprocessable(`Timesheet is ${row.status}; only a submitted timesheet can be decided.`);

  const updated = await prisma.timesheet.update({
    where: { id },
    data: { status: approve ? 'approved' : 'rejected', decidedById: auth.partyId, decidedAt: new Date(), decisionNote: note },
  });
  await emit({
    name: approve ? EVENTS.TIMESHEET_APPROVED : EVENTS.TIMESHEET_REJECTED,
    subject: { entityType: 'timesheet', entityId: id, recordCode: row.recordCode },
    related: [{ relation: 'covers', entityType: 'employment_relationship', entityId: row.employmentRelationshipId }],
    previousState: { status: row.status },
    newState: { status: updated.status, note },
    reason: { reasonCode: approve ? 'approved' : 'rejected' },
    impact: { domains: ['hr'] },
  });
  return updated;
}

export const approveTimesheet = (id: string, note?: string) => decideTimesheet(id, true, note ?? null);
export const rejectTimesheet = (id: string, note: string) => decideTimesheet(id, false, note);

// ---------------------------------------------------------------------------
// Overtime requests
// ---------------------------------------------------------------------------

export async function listOvertimeRequests(employmentRelationshipId?: string) {
  const auth = currentAuth();
  await assertCan({ resource: 'overtime_requests', verb: 'view' });
  const scopeWhere = employmentRelationshipId ? {} : await ownScopeWhere('overtime_requests', 'view');
  return prisma.overtimeRequest.findMany({
    where: { tenantId: auth.tenantId, ...(employmentRelationshipId ? { employmentRelationshipId } : {}), ...scopeWhere },
    orderBy: { date: 'desc' },
  });
}

export async function requestOvertime(input: { employmentRelationshipId: string; date: Date; hours: number; reason?: string | null }) {
  const auth = currentAuth();
  await assertCan({ resource: 'overtime_requests', verb: 'create' });
  await assertEmploymentVisible('overtime_requests', input.employmentRelationshipId);
  if (input.hours <= 0 || input.hours > 12) throw ApiError.badRequest('Overtime hours must be more than 0 and no more than 12 for a single request.');

  const row = await prisma.overtimeRequest.create({
    data: {
      tenantId: auth.tenantId,
      employmentRelationshipId: input.employmentRelationshipId,
      date: dayStart(input.date),
      hours: input.hours,
      reason: input.reason ?? null,
    },
  });
  await emit({
    name: EVENTS.OVERTIME_REQUEST_SUBMITTED,
    subject: { entityType: 'overtime_request', entityId: row.id },
    related: [{ relation: 'requests_for', entityType: 'employment_relationship', entityId: input.employmentRelationshipId }],
    newState: { date: ymd(row.date), hours: input.hours },
    impact: { domains: ['hr'] },
  });
  return row;
}

async function decideOvertime(id: string, approve: boolean, note: string | null) {
  const auth = currentAuth();
  const row = await prisma.overtimeRequest.findFirst({ where: { id, tenantId: auth.tenantId } });
  if (!row) throw ApiError.notFound('Overtime request');
  await assertCan({ resource: 'overtime_requests', verb: 'approve' });

  const employment = await prisma.employmentRelationship.findFirst({ where: { id: row.employmentRelationshipId }, select: { personId: true } });
  selfDealingCheck(employment?.personId ?? null, auth.partyId);

  if (row.status !== 'requested') throw ApiError.unprocessable(`Overtime request is ${row.status}; only a requested one can be decided.`);

  const updated = await prisma.overtimeRequest.update({
    where: { id },
    data: { status: approve ? 'approved' : 'rejected', decidedById: auth.partyId, decidedAt: new Date(), decisionNote: note },
  });

  await emit({
    name: approve ? EVENTS.OVERTIME_REQUEST_APPROVED : EVENTS.OVERTIME_REQUEST_REJECTED,
    subject: { entityType: 'overtime_request', entityId: id },
    related: [{ relation: 'requests_for', entityType: 'employment_relationship', entityId: row.employmentRelationshipId }],
    previousState: { status: row.status },
    newState: { status: updated.status, note },
    reason: { reasonCode: approve ? 'approved' : 'rejected' },
    impact: { domains: ['hr'] },
  });

  // Approving overtime is also what earns the comp-off — a separate "earn"
  // step would let one exist without the other ever having happened.
  if (approve) {
    const days = compOffDaysForHours(num(row.hours) ?? 0);
    if (days > 0) {
      const earnedOn = new Date();
      const compOff = await prisma.compOff.create({
        data: {
          tenantId: auth.tenantId,
          employmentRelationshipId: row.employmentRelationshipId,
          earnedFrom: 'overtime',
          sourceRef: row.id,
          earnedOn,
          days,
          expiresOn: compOffExpiryDate(earnedOn),
        },
      });
      await emit({
        name: EVENTS.COMP_OFF_EARNED,
        subject: { entityType: 'comp_off', entityId: compOff.id },
        related: [
          { relation: 'earned_from', entityType: 'overtime_request', entityId: row.id },
          { relation: 'credited_to', entityType: 'employment_relationship', entityId: row.employmentRelationshipId },
        ],
        newState: { days, expiresOn: ymd(compOff.expiresOn) },
        impact: { domains: ['hr'] },
      });
    }
  }

  return updated;
}

export const approveOvertimeRequest = (id: string, note?: string) => decideOvertime(id, true, note ?? null);
export const rejectOvertimeRequest = (id: string, note: string) => decideOvertime(id, false, note);

/** Records comp-off earned directly from holiday work — no pre-approval flow, since the day worked is already an accomplished fact by the time this is filed. */
export async function earnCompOffForHolidayWork(input: { employmentRelationshipId: string; earnedOn: Date; days: number; note?: string | null }) {
  const auth = currentAuth();
  await assertCan({ resource: 'comp_offs', verb: 'create' });
  await assertEmploymentVisible('comp_offs', input.employmentRelationshipId);
  if (input.days <= 0 || input.days > 2) throw ApiError.badRequest('Comp-off for one day worked must be more than 0 and no more than 2 days.');

  const earnedOn = dayStart(input.earnedOn);
  const row = await prisma.compOff.create({
    data: {
      tenantId: auth.tenantId,
      employmentRelationshipId: input.employmentRelationshipId,
      earnedFrom: 'holiday_work',
      earnedOn,
      days: input.days,
      expiresOn: compOffExpiryDate(earnedOn),
      note: input.note ?? null,
    },
  });
  await emit({
    name: EVENTS.COMP_OFF_EARNED,
    subject: { entityType: 'comp_off', entityId: row.id },
    related: [{ relation: 'credited_to', entityType: 'employment_relationship', entityId: input.employmentRelationshipId }],
    newState: { days: input.days, expiresOn: ymd(row.expiresOn) },
    impact: { domains: ['hr'] },
  });
  return row;
}

// ---------------------------------------------------------------------------
// Comp-off
// ---------------------------------------------------------------------------

export async function listCompOffs(employmentRelationshipId?: string) {
  const auth = currentAuth();
  await assertCan({ resource: 'comp_offs', verb: 'view' });
  const scopeWhere = employmentRelationshipId ? {} : await ownScopeWhere('comp_offs', 'view');
  return prisma.compOff.findMany({
    where: { tenantId: auth.tenantId, ...(employmentRelationshipId ? { employmentRelationshipId } : {}), ...scopeWhere },
    orderBy: { earnedOn: 'desc' },
  });
}

export async function consumeCompOff(id: string, consumedOn: Date = new Date()) {
  const auth = currentAuth();
  const row = await prisma.compOff.findFirst({ where: { id, tenantId: auth.tenantId } });
  if (!row) throw ApiError.notFound('Comp-off');
  await assertEmploymentVisible('comp_offs', row.employmentRelationshipId, 'edit');

  if (row.status !== 'available') throw ApiError.unprocessable(`This comp-off is ${row.status}, not available to consume.`);
  if (new Date() >= row.expiresOn) {
    await prisma.compOff.update({ where: { id }, data: { status: 'expired' } });
    throw ApiError.unprocessable(`This comp-off expired on ${ymd(row.expiresOn)} and can no longer be consumed.`);
  }

  const updated = await prisma.compOff.update({ where: { id }, data: { status: 'consumed', consumedOn: dayStart(consumedOn) } });
  await emit({
    name: EVENTS.COMP_OFF_CONSUMED,
    subject: { entityType: 'comp_off', entityId: id },
    related: [{ relation: 'credited_to', entityType: 'employment_relationship', entityId: row.employmentRelationshipId }],
    newState: { consumedOn: ymd(updated.consumedOn!) },
    impact: { domains: ['hr'] },
  });
  return updated;
}

/** The comp-off expiry sweep. Every `available` row past its `expiresOn` becomes `expired`, with an event per row rather than a silent bulk update. */
export async function runCompOffExpiry(): Promise<JobResult> {
  const auth = currentAuth();
  const now = new Date();
  const expiring = await prisma.compOff.findMany({
    where: { tenantId: auth.tenantId, status: 'available', expiresOn: { lt: now } },
  });

  for (const row of expiring) {
    await prisma.compOff.update({ where: { id: row.id }, data: { status: 'expired' } });
    await emit({
      name: EVENTS.COMP_OFF_EXPIRED,
      subject: { entityType: 'comp_off', entityId: row.id },
      related: [{ relation: 'credited_to', entityType: 'employment_relationship', entityId: row.employmentRelationshipId }],
      newState: { expiresOn: ymd(row.expiresOn), days: num(row.days) },
      impact: { domains: ['hr'] },
    });
  }

  return { processed: expiring.length, notified: 0, skippedIdempotent: 0, errors: [] };
}

// ---------------------------------------------------------------------------
// Attendance regularisation
// ---------------------------------------------------------------------------

export async function listRegularisations(employmentRelationshipId?: string) {
  const auth = currentAuth();
  await assertCan({ resource: 'attendance_regularisations', verb: 'view' });
  const scopeWhere = employmentRelationshipId ? {} : await ownScopeWhere('attendance_regularisations', 'view');
  return prisma.attendanceRegularisation.findMany({
    where: { tenantId: auth.tenantId, ...(employmentRelationshipId ? { employmentRelationshipId } : {}), ...scopeWhere },
    orderBy: { date: 'desc' },
  });
}

/**
 * Submits a regularisation request. If the day has no `WorkAttendance` row at
 * all — a missed punch — one is created first so there is a record for the
 * machine to move; either way the row is driven into `Disputed` while the
 * request is open.
 */
export async function submitRegularisation(input: { employmentRelationshipId: string; date: Date; reason: string }) {
  const auth = currentAuth();
  await assertCan({ resource: 'attendance_regularisations', verb: 'create' });
  await assertEmploymentVisible('attendance_regularisations', input.employmentRelationshipId);
  if (!input.reason.trim()) throw ApiError.badRequest('A reason is required.');

  const day = dayStart(input.date);
  let attendance = await prisma.workAttendance.findUnique({
    where: { employmentRelationshipId_workDate: { employmentRelationshipId: input.employmentRelationshipId, workDate: day } },
  });
  if (!attendance) {
    attendance = await prisma.workAttendance.create({
      data: { tenantId: auth.tenantId, employmentRelationshipId: input.employmentRelationshipId, workDate: day, workedMinutes: 0, missingPunch: true },
    });
  }
  if (attendance.status === 'Locked') {
    throw ApiError.unprocessable(`Attendance for ${ymd(day)} is Locked — the pay period is closed. This cannot be regularised.`);
  }
  if (attendance.status !== 'Disputed') {
    await transitionAttendance(attendance.id, 'DISPUTE', input.reason);
  }

  const row = await prisma.attendanceRegularisation.create({
    data: {
      tenantId: auth.tenantId,
      employmentRelationshipId: input.employmentRelationshipId,
      workAttendanceId: attendance.id,
      date: day,
      reason: input.reason,
    },
  });
  await emit({
    name: EVENTS.ATTENDANCE_REGULARISATION_SUBMITTED,
    subject: { entityType: 'attendance_regularisation', entityId: row.id },
    related: [
      { relation: 'covers', entityType: 'employment_relationship', entityId: input.employmentRelationshipId },
      { relation: 'disputes', entityType: 'work_attendance', entityId: attendance.id },
    ],
    newState: { date: ymd(day), reason: input.reason },
    impact: { domains: ['hr'] },
  });
  return row;
}

async function decideRegularisation(id: string, approve: boolean, note: string | null, correctedWorkedMinutes?: number) {
  const auth = currentAuth();
  const row = await prisma.attendanceRegularisation.findFirst({ where: { id, tenantId: auth.tenantId } });
  if (!row) throw ApiError.notFound('Attendance regularisation request');
  await assertCan({ resource: 'attendance_regularisations', verb: 'approve' });

  const employment = await prisma.employmentRelationship.findFirst({ where: { id: row.employmentRelationshipId }, select: { personId: true } });
  selfDealingCheck(employment?.personId ?? null, auth.partyId);

  if (row.status !== 'submitted') throw ApiError.unprocessable(`This request is ${row.status}; only a submitted one can be decided.`);

  if (approve) {
    if (correctedWorkedMinutes !== undefined) {
      await prisma.workAttendance.update({ where: { id: row.workAttendanceId }, data: { workedMinutes: correctedWorkedMinutes } });
    }
    await transitionAttendance(row.workAttendanceId, 'REGULARISE', note ?? undefined);
  }

  const updated = await prisma.attendanceRegularisation.update({
    where: { id },
    data: { status: approve ? 'approved' : 'rejected', decidedById: auth.partyId, decidedAt: new Date(), decisionNote: note },
  });

  await emit({
    name: approve ? EVENTS.ATTENDANCE_REGULARISATION_APPROVED : EVENTS.ATTENDANCE_REGULARISATION_REJECTED,
    subject: { entityType: 'attendance_regularisation', entityId: id },
    related: [{ relation: 'covers', entityType: 'employment_relationship', entityId: row.employmentRelationshipId }],
    previousState: { status: row.status },
    newState: { status: updated.status, note },
    reason: { reasonCode: approve ? 'approved' : 'rejected' },
    impact: { domains: ['hr'] },
  });

  if (!approve) {
    await raiseException({
      code: 'EX-HR-006',
      label: 'Attendance regularisation declined; the day stays disputed',
      severity: 'S1_ATTENTION',
      subjectType: 'work_attendance',
      subjectId: row.workAttendanceId,
      subjectLabel: ymd(row.date),
      domain: 'hr',
      detail: `The regularisation request for ${ymd(row.date)} was declined (${note ?? 'no reason given'}). The attendance day is still Disputed and needs a fresh request or a manual resolution before the pay period can lock cleanly.`,
      ownerPartyId: employment?.personId ?? null,
      reasonCode: 'regularisation_declined',
    });
  }

  return updated;
}

export const approveRegularisation = (id: string, note?: string, correctedWorkedMinutes?: number) =>
  decideRegularisation(id, true, note ?? null, correctedWorkedMinutes);
export const rejectRegularisation = (id: string, note: string) => decideRegularisation(id, false, note);
