/**
 * HCM — G2. Time (docs/hcm/time.md).
 *
 * Pure logic only: shift-window arithmetic, late/early/half-day
 * classification from a punch pair, weekly-hours totals, and the comp-off
 * expiry rule. Nothing here touches a database or a request context — the
 * domain layer (apps/api/src/domains/hcm/time.ts) is the only caller.
 */

export const HCM_TIME_MODULE = 'time' as const;

export type ClockKind = 'in' | 'out';
export type ClockSource = 'web' | 'mobile' | 'biometric_import';
export const CLOCK_SOURCES: ClockSource[] = ['web', 'mobile', 'biometric_import'];

export type TimesheetStatus = 'draft' | 'submitted' | 'approved' | 'rejected';
export type OvertimeStatus = 'requested' | 'approved' | 'rejected';
export type CompOffStatus = 'available' | 'consumed' | 'expired';
export type CompOffSource = 'overtime' | 'holiday_work';
export type RegularisationStatus = 'submitted' | 'approved' | 'rejected';

/** A comp-off is good for 90 days from the day it was earned unless a tenant says otherwise. */
export const COMP_OFF_DEFAULT_VALIDITY_DAYS = 90;

export interface ShiftDef {
  startMinutes: number;
  endMinutes: number;
  graceMinutes: number;
  breakMinutes: number;
  nightShift: boolean;
}

/** Parses "HH:MM" into minutes since midnight. Throws on anything else — a shift's hours are never guessed. */
export function parseHHMM(value: string): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!m) throw new Error(`"${value}" is not an HH:MM time.`);
  const h = Number(m[1]);
  const mm = Number(m[2]);
  if (h < 0 || h > 23 || mm < 0 || mm > 59) throw new Error(`"${value}" is not a valid time of day.`);
  return h * 60 + mm;
}

export function formatHHMM(minutesOfDay: number): string {
  const norm = ((minutesOfDay % 1440) + 1440) % 1440;
  const h = Math.floor(norm / 60);
  const m = norm % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/** A shift's paid span, net of its unpaid break — what counts as a full day. */
export function shiftScheduledMinutes(shift: ShiftDef): number {
  const span = shift.nightShift
    ? 1440 - shift.startMinutes + shift.endMinutes
    : shift.endMinutes - shift.startMinutes;
  return Math.max(span - shift.breakMinutes, 0);
}

export interface PunchClassification {
  lateMinutes: number;
  earlyLeaveMinutes: number;
  workedMinutes: number;
  overtimeMinutes: number;
  halfDay: boolean;
  status: 'on_time' | 'late' | 'half_day' | 'absent';
}

/**
 * Classifies one day's punch pair against its shift. `clockInMinutes` and
 * `clockOutMinutes` are minutes-of-day (local clock time, not UTC-of-instant);
 * for a night shift a clock-out smaller than clock-in is understood to have
 * crossed midnight rather than being an early, impossible exit.
 */
export function classifyPunch(
  shift: ShiftDef,
  clockInMinutes: number | null,
  clockOutMinutes: number | null,
): PunchClassification {
  if (clockInMinutes === null || clockOutMinutes === null) {
    return {
      lateMinutes: 0,
      earlyLeaveMinutes: 0,
      workedMinutes: 0,
      overtimeMinutes: 0,
      halfDay: false,
      status: 'absent',
    };
  }

  const scheduled = shiftScheduledMinutes(shift);
  const lateMinutes = Math.max(clockInMinutes - (shift.startMinutes + shift.graceMinutes), 0);
  const earlyLeaveMinutes = Math.max(shift.endMinutes - shift.graceMinutes - clockOutMinutes, 0);

  let outAdjusted = clockOutMinutes;
  if (shift.nightShift && clockOutMinutes < clockInMinutes) outAdjusted += 1440;
  const rawWorked = Math.max(outAdjusted - clockInMinutes - shift.breakMinutes, 0);

  const halfDay = scheduled > 0 && rawWorked > 0 && rawWorked < scheduled / 2;
  const overtimeMinutes = Math.max(rawWorked - scheduled, 0);

  const status: PunchClassification['status'] = halfDay ? 'half_day' : lateMinutes > 0 ? 'late' : 'on_time';

  return { lateMinutes, earlyLeaveMinutes, workedMinutes: rawWorked, overtimeMinutes, halfDay, status };
}

/** Sums a week's entry hours to two decimal places — never a floating-point-noisy total. */
export function weeklyHoursTotal(entryHours: number[]): number {
  const total = entryHours.reduce((a, b) => a + b, 0);
  return Math.round(total * 100) / 100;
}

/** The Monday (UTC midnight) of the ISO week containing `d`. */
export function weekStartMonday(d: Date): Date {
  const day = d.getUTCDay(); // 0 Sun .. 6 Sat
  const diff = (day === 0 ? -6 : 1) - day;
  const monday = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  monday.setUTCDate(monday.getUTCDate() + diff);
  return monday;
}

/** Comp-off days earned for a stretch of overtime — half a day per 4 hours, rounded down to the nearest half day. */
export function compOffDaysForHours(hours: number): number {
  return Math.floor((hours / 4) * 2) / 2;
}

export function compOffExpiryDate(earnedOn: Date, validityDays: number = COMP_OFF_DEFAULT_VALIDITY_DAYS): Date {
  const d = new Date(earnedOn);
  d.setUTCDate(d.getUTCDate() + validityDays);
  return d;
}

export function isCompOffExpired(expiresOn: Date, asOf: Date = new Date()): boolean {
  return asOf.getTime() >= expiresOn.getTime();
}

/** True when `date`'s weekday (0 Sun..6 Sat, UTC) is one of the roster's declared weekly offs. */
export function isWeeklyOff(date: Date, weeklyOffDays: number[]): boolean {
  return weeklyOffDays.includes(date.getUTCDay());
}
