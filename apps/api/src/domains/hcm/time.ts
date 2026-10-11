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
  istDateKey,
  istMidnight,
  istMinuteOfDay,
  parseHHMM,
  weekStartMonday,
  weeklyHoursTotal,
  type ShiftDef,
  type Verb,
} from '@kaizen/shared';
import { prisma, num } from '../../platform/db.js';
import { asSystem, currentAuth } from '../../platform/context.js';
import { emit } from '../../platform/eventBus.js';
import { nextRecordCode } from '../../platform/recordCode.js';
import { ApiError } from '../../platform/errors.js';
import { assertCan, assertScopeAll, scopeFor } from '../../platform/permissions.js';
import { assertEmploymentVisible } from '../../platform/recordScope.js';
import { auditWrite, registerGovernedEntities } from '../../platform/audit.js';
import { governedWrite } from '../../platform/governedWrite.js';
import { raiseException } from '../../platform/exceptions.js';
import { transitionAttendance } from '../leave.js';
import type { JobResult } from '../../jobs/scheduler.js';

registerGovernedEntities('hcm_time', [
  'shift',
  'roster_assignment',
  'clock_event',
  'timesheet',
  'timesheet_entry',
  'overtime_request',
  'comp_off',
  'attendance_regularisation',
]);

/**
 * The IST civil date of an instant as YYYY-MM-DD. Date-only columns hold
 * UTC midnight of that date (see `dayStart`), so reading one back through
 * this is exact; reading an instant through it gives the IST day, not the UTC day.
 */
function ymd(d: Date): string {
  return istDateKey(d);
}

/**
 * UTC midnight of the IST civil date of `d` — the storage form of a
 * date-only value. A date-only input parsed as UTC midnight is 05:30 IST on
 * the same date, so re-deriving it here is a no-op for those.
 */
function dayStart(d: Date): Date {
  return new Date(`${istDateKey(d)}T00:00:00.000Z`);
}

/**
 * The IST day before the one `now` falls in, in storage form. IST has no DST,
 * so stepping back 24 hours from IST midnight is exact. Stepping back 24 hours
 * from `now` itself lands on the wrong day between 00:00 and 05:30 IST.
 */
export function yesterdayIst(now: Date): Date {
  return new Date(dayStart(now).getTime() - 86_400_000);
}

/** The instants an IST civil day runs between, for instant-valued columns. */
function istDayBounds(day: Date): { start: Date; end: Date } {
  const [y, m, d] = ymd(day).split('-').map(Number);
  return { start: istMidnight(y!, m!, d!), end: istMidnight(y!, m!, d! + 1) };
}

/** The active employment behind the calling user's own account — what every `/me` endpoint resolves against. */
export async function myEmploymentId(): Promise<string> {
  const auth = currentAuth();
  if (!auth.partyId) throw ApiError.unprocessable('No person is attached to this account.');
  const employment = await prisma.employmentRelationship.findFirst({
    where: {
      tenantId: auth.tenantId,
      personId: auth.partyId,
      deletedAt: null,
      status: { notIn: ['OfferRescinded', 'NoShow'] },
    },
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

/**
 * The WHERE fragment for a "list, optionally filtered to one employment"
 * endpoint. An explicit `employmentRelationshipId` is never trusted at face
 * value — an own-scoped caller passing a colleague's id must be refused (404,
 * a visibility fact) exactly as reading that colleague's record by id would
 * be, not treated as an escape hatch around the scope filter that applies
 * when no id is given. Skipping this check when an id is present was a real
 * bug here (alert-scope.md): the WHO axis alone (`assertCan`) does not
 * evaluate the WHERE axis — only a scope check or a resolved record does.
 */
async function listWhere(
  resource: string,
  verb: Verb,
  employmentRelationshipId?: string,
): Promise<Record<string, unknown>> {
  if (employmentRelationshipId) {
    await assertEmploymentVisible(resource, employmentRelationshipId, verb);
    return { employmentRelationshipId };
  }
  return ownScopeWhere(resource, verb);
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

function shiftDef(shift: {
  startTime: string;
  endTime: string;
  graceMinutes: number;
  breakMinutes: number;
  nightShift: boolean;
}): ShiftDef {
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

  return governedWrite(async (tx) => {
    const row = await tx.shift.create({
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
    await auditWrite({ action: 'create', subjectType: 'shift', subjectId: row.id, after: row as never, tx });
    await emit({
      name: EVENTS.SHIFT_CREATED,
      subject: { entityType: 'shift', entityId: row.id },
      newState: { code: row.code, name: row.name },
      impact: { domains: ['hr'] },
      tx,
    });
    return row;
  });
}

export async function updateShift(
  id: string,
  patch: { name?: string; graceMinutes?: number; breakMinutes?: number; active?: boolean },
) {
  const auth = currentAuth();
  await assertCan({ resource: 'shifts', verb: 'edit' });
  const existing = await prisma.shift.findFirst({ where: { id, tenantId: auth.tenantId } });
  if (!existing) throw ApiError.notFound('Shift');
  const row = await prisma.shift.update({ where: { id }, data: patch });
  await auditWrite({
    action: 'update',
    subjectType: 'shift',
    subjectId: id,
    before: existing as never,
    after: row as never,
  });
  return row;
}

// ---------------------------------------------------------------------------
// Roster
// ---------------------------------------------------------------------------

export async function listRosterAssignments(employmentRelationshipId?: string) {
  const auth = currentAuth();
  await assertCan({ resource: 'rosters', verb: 'view' });
  const where = await listWhere('rosters', 'view', employmentRelationshipId);
  return prisma.rosterAssignment.findMany({
    where: { tenantId: auth.tenantId, ...where },
    orderBy: { effectiveFrom: 'desc' },
  });
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
  await assertEmploymentVisible('rosters', input.employmentRelationshipId, 'create');

  const shift = await prisma.shift.findFirst({ where: { id: input.shiftId, tenantId: auth.tenantId } });
  if (!shift) throw ApiError.notFound('Shift');

  return governedWrite(async (tx) => {
    const row = await tx.rosterAssignment.create({
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
    await auditWrite({
      action: 'create',
      subjectType: 'roster_assignment',
      subjectId: row.id,
      after: row as never,
      tx,
    });
    await emit({
      name: EVENTS.ROSTER_PUBLISHED,
      subject: { entityType: 'roster_assignment', entityId: row.id },
      related: [
        { relation: 'assigns', entityType: 'employment_relationship', entityId: input.employmentRelationshipId },
      ],
      newState: { shiftId: input.shiftId, effectiveFrom: ymd(row.effectiveFrom) },
      impact: { domains: ['hr'] },
      tx,
    });
    return row;
  });
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
  await assertEmploymentVisible('clock_events', input.employmentRelationshipId, 'create');

  const last = await lastOpenClock(input.employmentRelationshipId, auth.tenantId);
  if (input.kind === 'in' && last?.kind === 'in') {
    throw ApiError.unprocessable('Already clocked in — clock out before clocking in again.');
  }
  if (input.kind === 'out' && (!last || last.kind === 'out')) {
    throw ApiError.unprocessable('No open clock-in to close. Clock in first.');
  }

  return governedWrite(async (tx) => {
    const row = await tx.clockEvent.create({
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

    await auditWrite({ action: 'create', subjectType: 'clock_event', subjectId: row.id, after: row as never, tx });
    await emit({
      name: EVENTS.CLOCK_EVENT_RECORDED,
      subject: { entityType: 'clock_event', entityId: row.id },
      related: [
        { relation: 'punches', entityType: 'employment_relationship', entityId: input.employmentRelationshipId },
      ],
      newState: { kind: row.kind, occurredAt: row.occurredAt.toISOString(), source: row.source },
      impact: { domains: ['hr'] },
      tx,
    });

    return row;
  });
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
export async function deriveAttendanceFromClockEvents(forDate: Date = yesterdayIst(new Date())): Promise<JobResult> {
  const auth = currentAuth();
  // A tenant-wide recompute, reachable directly via `/jobs/derive-attendance`
  // as well as the nightly scheduler (which runs it as the system principal,
  // for which every scope resolves to `all`) — so a manual trigger needs the
  // same all-scope authority the scheduler always has, not merely
  // `clock_events:view`, which an own-scoped employee also holds.
  await assertScopeAll('attendance', 'edit');
  const day = dayStart(forDate);
  // The punches of an IST civil day, not a UTC one: a 00:30 IST clock-in is
  // 19:00Z the previous day and would otherwise be dropped from this day.
  const { start, end } = istDayBounds(day);

  const events = await prisma.clockEvent.findMany({
    where: { tenantId: auth.tenantId, occurredAt: { gte: start, lt: end } },
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
      // Roster HH:MM is IST wall-clock (no zone on `Shift`; the platform is
      // India-only), so a punch is read in IST before it is compared with it.
      const inMinutes = firstIn ? istMinuteOfDay(firstIn.occurredAt) : null;
      const outMinutes = lastOut ? istMinuteOfDay(lastOut.occurredAt) : null;

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
    where: {
      tenantId_employmentRelationshipId_weekStart: {
        tenantId: auth.tenantId,
        employmentRelationshipId,
        weekStart: monday,
      },
    },
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
  const where = await listWhere('timesheets', 'view', employmentRelationshipId);
  return prisma.timesheet.findMany({ where: { tenantId: auth.tenantId, ...where }, orderBy: { weekStart: 'desc' } });
}

export async function getTimesheet(id: string) {
  const auth = currentAuth();
  await assertCan({ resource: 'timesheets', verb: 'view' });
  const row = await prisma.timesheet.findFirst({ where: { id, tenantId: auth.tenantId } });
  if (!row) throw ApiError.notFound('Timesheet');
  const scope = await scopeFor('timesheets', 'view');
  if (scope !== 'all') {
    const employment = await prisma.employmentRelationship.findFirst({
      where: { id: row.employmentRelationshipId },
      select: { personId: true },
    });
    if (employment?.personId !== auth.partyId) throw ApiError.notFound('Timesheet');
  }
  const entries = await prisma.timesheetEntry.findMany({
    where: { tenantId: auth.tenantId, timesheetId: id },
    orderBy: { date: 'asc' },
  });
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
  await assertEmploymentVisible('timesheets', input.employmentRelationshipId, 'create');
  if (input.hours <= 0 || input.hours > 24)
    throw ApiError.badRequest('Hours for a single entry must be more than 0 and no more than 24.');

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
  if (!timesheet) throw ApiError.notFound('Timesheet entry');
  // `assertCan` alone only checks the WHO axis — an own-scoped caller holding
  // `timesheets:edit`@own could otherwise delete a colleague's entry just by
  // knowing its id (alert-scope.md). The WHERE axis has to be checked against
  // the entry's OWN timesheet, not the caller's.
  await assertEmploymentVisible('timesheets', timesheet.employmentRelationshipId, 'edit');
  if (timesheet.status !== 'draft' && timesheet.status !== 'rejected') {
    throw ApiError.unprocessable(`This timesheet is ${timesheet.status} — it cannot be edited further.`);
  }
  await prisma.timesheetEntry.delete({ where: { id } });
  await recomputeTimesheetTotal(auth.tenantId, timesheet.id);
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

  return governedWrite(async (tx) => {
    const updated = await tx.timesheet.update({
      where: { id },
      data: { status: 'submitted', submittedAt: new Date(), decisionNote: null },
    });
    await auditWrite({
      action: 'update',
      subjectType: 'timesheet',
      subjectId: id,
      before: { status: row.status },
      after: { status: 'submitted' },
      tx,
    });
    await emit({
      name: EVENTS.TIMESHEET_SUBMITTED,
      subject: { entityType: 'timesheet', entityId: id, recordCode: row.recordCode },
      related: [{ relation: 'covers', entityType: 'employment_relationship', entityId: row.employmentRelationshipId }],
      newState: { status: 'submitted', totalHours: num(row.totalHours) },
      impact: { domains: ['hr'] },
      tx,
    });
    return updated;
  });
}

async function decideTimesheet(id: string, approve: boolean, note: string | null) {
  const auth = currentAuth();
  const row = await prisma.timesheet.findFirst({ where: { id, tenantId: auth.tenantId } });
  if (!row) throw ApiError.notFound('Timesheet');
  await assertCan({ resource: 'timesheets', verb: 'approve' });

  const employment = await prisma.employmentRelationship.findFirst({
    where: { id: row.employmentRelationshipId },
    select: { personId: true },
  });
  selfDealingCheck(employment?.personId ?? null, auth.partyId);

  if (row.status !== 'submitted')
    throw ApiError.unprocessable(`Timesheet is ${row.status}; only a submitted timesheet can be decided.`);

  return governedWrite(async (tx) => {
    const updated = await tx.timesheet.update({
      where: { id },
      data: {
        status: approve ? 'approved' : 'rejected',
        decidedById: auth.partyId,
        decidedAt: new Date(),
        decisionNote: note,
      },
    });
    await auditWrite({
      action: 'update',
      subjectType: 'timesheet',
      subjectId: id,
      before: { status: row.status },
      after: { status: updated.status },
      tx,
    });
    await emit({
      name: approve ? EVENTS.TIMESHEET_APPROVED : EVENTS.TIMESHEET_REJECTED,
      subject: { entityType: 'timesheet', entityId: id, recordCode: row.recordCode },
      related: [{ relation: 'covers', entityType: 'employment_relationship', entityId: row.employmentRelationshipId }],
      previousState: { status: row.status },
      newState: { status: updated.status, note },
      reason: { reasonCode: approve ? 'approved' : 'rejected' },
      impact: { domains: ['hr'] },
      tx,
    });
    return updated;
  });
}

export const approveTimesheet = (id: string, note?: string) => decideTimesheet(id, true, note ?? null);
export const rejectTimesheet = (id: string, note: string) => decideTimesheet(id, false, note);

// ---------------------------------------------------------------------------
// Overtime requests
// ---------------------------------------------------------------------------

export async function listOvertimeRequests(employmentRelationshipId?: string) {
  const auth = currentAuth();
  await assertCan({ resource: 'overtime_requests', verb: 'view' });
  const where = await listWhere('overtime_requests', 'view', employmentRelationshipId);
  return prisma.overtimeRequest.findMany({ where: { tenantId: auth.tenantId, ...where }, orderBy: { date: 'desc' } });
}

export async function requestOvertime(input: {
  employmentRelationshipId: string;
  date: Date;
  hours: number;
  reason?: string | null;
}) {
  const auth = currentAuth();
  await assertCan({ resource: 'overtime_requests', verb: 'create' });
  await assertEmploymentVisible('overtime_requests', input.employmentRelationshipId, 'create');
  if (input.hours <= 0 || input.hours > 12)
    throw ApiError.badRequest('Overtime hours must be more than 0 and no more than 12 for a single request.');

  return governedWrite(async (tx) => {
    const row = await tx.overtimeRequest.create({
      data: {
        tenantId: auth.tenantId,
        employmentRelationshipId: input.employmentRelationshipId,
        date: dayStart(input.date),
        hours: input.hours,
        reason: input.reason ?? null,
      },
    });
    await auditWrite({ action: 'create', subjectType: 'overtime_request', subjectId: row.id, after: row as never, tx });
    await emit({
      name: EVENTS.OVERTIME_REQUEST_SUBMITTED,
      subject: { entityType: 'overtime_request', entityId: row.id },
      related: [
        { relation: 'requests_for', entityType: 'employment_relationship', entityId: input.employmentRelationshipId },
      ],
      newState: { date: ymd(row.date), hours: input.hours },
      impact: { domains: ['hr'] },
      tx,
    });
    return row;
  });
}

async function decideOvertime(id: string, approve: boolean, note: string | null) {
  const auth = currentAuth();
  const row = await prisma.overtimeRequest.findFirst({ where: { id, tenantId: auth.tenantId } });
  if (!row) throw ApiError.notFound('Overtime request');
  await assertCan({ resource: 'overtime_requests', verb: 'approve' });

  const employment = await prisma.employmentRelationship.findFirst({
    where: { id: row.employmentRelationshipId },
    select: { personId: true },
  });
  selfDealingCheck(employment?.personId ?? null, auth.partyId);

  if (row.status !== 'requested')
    throw ApiError.unprocessable(`Overtime request is ${row.status}; only a requested one can be decided.`);

  // The decision and, when approved, the comp-off it earns commit together: a
  // comp-off with no approved overtime behind it is the case this prevents.
  return governedWrite(async (tx) => {
    const updated = await tx.overtimeRequest.update({
      where: { id },
      data: {
        status: approve ? 'approved' : 'rejected',
        decidedById: auth.partyId,
        decidedAt: new Date(),
        decisionNote: note,
      },
    });
    await auditWrite({
      action: 'update',
      subjectType: 'overtime_request',
      subjectId: id,
      before: { status: row.status },
      after: { status: updated.status },
      tx,
    });

    await emit({
      name: approve ? EVENTS.OVERTIME_REQUEST_APPROVED : EVENTS.OVERTIME_REQUEST_REJECTED,
      subject: { entityType: 'overtime_request', entityId: id },
      related: [
        { relation: 'requests_for', entityType: 'employment_relationship', entityId: row.employmentRelationshipId },
      ],
      previousState: { status: row.status },
      newState: { status: updated.status, note },
      reason: { reasonCode: approve ? 'approved' : 'rejected' },
      impact: { domains: ['hr'] },
      tx,
    });

    // Approving overtime is also what earns the comp-off — a separate "earn"
    // step would let one exist without the other ever having happened.
    if (approve) {
      const days = compOffDaysForHours(num(row.hours) ?? 0);
      if (days > 0) {
        const earnedOn = new Date();
        const compOff = await tx.compOff.create({
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
        await auditWrite({
          action: 'create',
          subjectType: 'comp_off',
          subjectId: compOff.id,
          after: compOff as never,
          tx,
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
          tx,
        });
      }
    }

    return updated;
  });
}

export const approveOvertimeRequest = (id: string, note?: string) => decideOvertime(id, true, note ?? null);
export const rejectOvertimeRequest = (id: string, note: string) => decideOvertime(id, false, note);

/** Records comp-off earned directly from holiday work — no pre-approval flow, since the day worked is already an accomplished fact by the time this is filed. */
export async function earnCompOffForHolidayWork(input: {
  employmentRelationshipId: string;
  earnedOn: Date;
  days: number;
  note?: string | null;
}) {
  const auth = currentAuth();
  await assertCan({ resource: 'comp_offs', verb: 'create' });
  await assertEmploymentVisible('comp_offs', input.employmentRelationshipId, 'create');
  if (input.days <= 0 || input.days > 2)
    throw ApiError.badRequest('Comp-off for one day worked must be more than 0 and no more than 2 days.');

  const earnedOn = dayStart(input.earnedOn);
  return governedWrite(async (tx) => {
    const row = await tx.compOff.create({
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
    await auditWrite({ action: 'create', subjectType: 'comp_off', subjectId: row.id, after: row as never, tx });
    await emit({
      name: EVENTS.COMP_OFF_EARNED,
      subject: { entityType: 'comp_off', entityId: row.id },
      related: [
        { relation: 'credited_to', entityType: 'employment_relationship', entityId: input.employmentRelationshipId },
      ],
      newState: { days: input.days, expiresOn: ymd(row.expiresOn) },
      impact: { domains: ['hr'] },
      tx,
    });
    return row;
  });
}

// ---------------------------------------------------------------------------
// Comp-off
// ---------------------------------------------------------------------------

export async function listCompOffs(employmentRelationshipId?: string) {
  const auth = currentAuth();
  await assertCan({ resource: 'comp_offs', verb: 'view' });
  const where = await listWhere('comp_offs', 'view', employmentRelationshipId);
  return prisma.compOff.findMany({ where: { tenantId: auth.tenantId, ...where }, orderBy: { earnedOn: 'desc' } });
}

export async function consumeCompOff(id: string, consumedOn: Date = new Date()) {
  const auth = currentAuth();
  const row = await prisma.compOff.findFirst({ where: { id, tenantId: auth.tenantId } });
  if (!row) throw ApiError.notFound('Comp-off');
  await assertEmploymentVisible('comp_offs', row.employmentRelationshipId, 'edit');

  if (row.status !== 'available')
    throw ApiError.unprocessable(`This comp-off is ${row.status}, not available to consume.`);
  if (new Date() >= row.expiresOn) {
    await prisma.compOff.update({ where: { id }, data: { status: 'expired' } });
    throw ApiError.unprocessable(`This comp-off expired on ${ymd(row.expiresOn)} and can no longer be consumed.`);
  }

  return governedWrite(async (tx) => {
    const updated = await tx.compOff.update({
      where: { id },
      data: { status: 'consumed', consumedOn: dayStart(consumedOn) },
    });
    await auditWrite({
      action: 'update',
      subjectType: 'comp_off',
      subjectId: id,
      before: { status: row.status },
      after: { status: 'consumed' },
      tx,
    });
    await emit({
      name: EVENTS.COMP_OFF_CONSUMED,
      subject: { entityType: 'comp_off', entityId: id },
      related: [
        { relation: 'credited_to', entityType: 'employment_relationship', entityId: row.employmentRelationshipId },
      ],
      newState: { consumedOn: ymd(updated.consumedOn!) },
      impact: { domains: ['hr'] },
      tx,
    });
    return updated;
  });
}

/** The comp-off expiry sweep. Every `available` row past its `expiresOn` becomes `expired`, with an event per row rather than a silent bulk update. */
export async function runCompOffExpiry(): Promise<JobResult> {
  const auth = currentAuth();
  // Same reasoning as `deriveAttendanceFromClockEvents`: a tenant-wide sweep,
  // reachable directly via `/jobs/expire-comp-offs` and not just the
  // scheduler, needs all-scope authority rather than the `view` an
  // own-scoped employee holds on `comp_offs`.
  await assertScopeAll('comp_offs', 'edit');
  const now = new Date();
  const expiring = await prisma.compOff.findMany({
    where: { tenantId: auth.tenantId, status: 'available', expiresOn: { lt: now } },
  });

  for (const row of expiring) {
    await governedWrite(async (tx) => {
      await tx.compOff.update({ where: { id: row.id }, data: { status: 'expired' } });
      await auditWrite({
        action: 'update',
        subjectType: 'comp_off',
        subjectId: row.id,
        before: { status: row.status },
        after: { status: 'expired' },
        tx,
      });
      await emit({
        name: EVENTS.COMP_OFF_EXPIRED,
        subject: { entityType: 'comp_off', entityId: row.id },
        related: [
          { relation: 'credited_to', entityType: 'employment_relationship', entityId: row.employmentRelationshipId },
        ],
        newState: { expiresOn: ymd(row.expiresOn), days: num(row.days) },
        impact: { domains: ['hr'] },
        tx,
      });
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
  const where = await listWhere('attendance_regularisations', 'view', employmentRelationshipId);
  return prisma.attendanceRegularisation.findMany({
    where: { tenantId: auth.tenantId, ...where },
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
  await assertEmploymentVisible('attendance_regularisations', input.employmentRelationshipId, 'create');
  if (!input.reason.trim()) throw ApiError.badRequest('A reason is required.');

  const day = dayStart(input.date);
  let attendance = await prisma.workAttendance.findUnique({
    where: {
      employmentRelationshipId_workDate: { employmentRelationshipId: input.employmentRelationshipId, workDate: day },
    },
  });
  if (!attendance) {
    attendance = await prisma.workAttendance.create({
      data: {
        tenantId: auth.tenantId,
        employmentRelationshipId: input.employmentRelationshipId,
        workDate: day,
        workedMinutes: 0,
        missingPunch: true,
      },
    });
  }
  if (attendance.status === 'Locked') {
    throw ApiError.unprocessable(
      `Attendance for ${ymd(day)} is Locked — the pay period is closed. This cannot be regularised.`,
    );
  }
  if (attendance.status !== 'Disputed') {
    // Driving the existing `WorkAttendance` machine is a side effect of an
    // action already gated on `attendance_regularisations:create` — the
    // filer need not separately hold `attendance:edit` (an own-scoped
    // employee never does), so this step runs as the platform.
    await asSystem(auth.tenantId, () => transitionAttendance(attendance!.id, 'DISPUTE', input.reason));
  }

  // The transitionAttendance call above is a nested service call that runs
  // outside this transaction; the regularisation row, its audit and its event
  // commit together.
  const attendanceId = attendance.id;
  return governedWrite(async (tx) => {
    const row = await tx.attendanceRegularisation.create({
      data: {
        tenantId: auth.tenantId,
        employmentRelationshipId: input.employmentRelationshipId,
        workAttendanceId: attendanceId,
        date: day,
        reason: input.reason,
      },
    });
    await auditWrite({
      action: 'create',
      subjectType: 'attendance_regularisation',
      subjectId: row.id,
      after: row as never,
      tx,
    });
    await emit({
      name: EVENTS.ATTENDANCE_REGULARISATION_SUBMITTED,
      subject: { entityType: 'attendance_regularisation', entityId: row.id },
      related: [
        { relation: 'covers', entityType: 'employment_relationship', entityId: input.employmentRelationshipId },
        { relation: 'disputes', entityType: 'work_attendance', entityId: attendanceId },
      ],
      newState: { date: ymd(day), reason: input.reason },
      impact: { domains: ['hr'] },
      tx,
    });
    return row;
  });
}

async function decideRegularisation(
  id: string,
  approve: boolean,
  note: string | null,
  correctedWorkedMinutes?: number,
) {
  const auth = currentAuth();
  const row = await prisma.attendanceRegularisation.findFirst({ where: { id, tenantId: auth.tenantId } });
  if (!row) throw ApiError.notFound('Attendance regularisation request');
  await assertCan({ resource: 'attendance_regularisations', verb: 'approve' });

  const employment = await prisma.employmentRelationship.findFirst({
    where: { id: row.employmentRelationshipId },
    select: { personId: true },
  });
  selfDealingCheck(employment?.personId ?? null, auth.partyId);

  if (row.status !== 'submitted')
    throw ApiError.unprocessable(`This request is ${row.status}; only a submitted one can be decided.`);

  if (approve) {
    if (correctedWorkedMinutes !== undefined) {
      await prisma.workAttendance.update({
        where: { id: row.workAttendanceId },
        data: { workedMinutes: correctedWorkedMinutes },
      });
    }
    await asSystem(auth.tenantId, () => transitionAttendance(row.workAttendanceId, 'REGULARISE', note ?? undefined));
  }

  // The WorkAttendance transition above and the exception below stay outside
  // this transaction: both are nested service calls on the scoped client.
  const updated = await governedWrite(async (tx) => {
    const decided = await tx.attendanceRegularisation.update({
      where: { id },
      data: {
        status: approve ? 'approved' : 'rejected',
        decidedById: auth.partyId,
        decidedAt: new Date(),
        decisionNote: note,
      },
    });
    await auditWrite({
      action: 'update',
      subjectType: 'attendance_regularisation',
      subjectId: id,
      before: { status: row.status },
      after: { status: decided.status },
      tx,
    });
    await emit({
      name: approve ? EVENTS.ATTENDANCE_REGULARISATION_APPROVED : EVENTS.ATTENDANCE_REGULARISATION_REJECTED,
      subject: { entityType: 'attendance_regularisation', entityId: id },
      related: [{ relation: 'covers', entityType: 'employment_relationship', entityId: row.employmentRelationshipId }],
      previousState: { status: row.status },
      newState: { status: decided.status, note },
      reason: { reasonCode: approve ? 'approved' : 'rejected' },
      impact: { domains: ['hr'] },
      tx,
    });
    return decided;
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
