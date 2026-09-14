import { toCsv } from './books.js';
/**
 * Compliance — F. Labour law and conduct (docs/plan/compliance.md).
 *
 * Pure arithmetic and shapes shared between the API and the web: working-day
 * counting that skips holidays and the weekly off, the POSH committee
 * checklist, and the letter templates a snapshot is built from. Nothing here
 * touches the database — every function takes the facts it needs as
 * arguments, the same discipline `finance.ts` keeps for GST set-off.
 */

// ---------------------------------------------------------------------------
// Holidays and working-day arithmetic
// ---------------------------------------------------------------------------

export const HOLIDAY_KINDS = ['national', 'state', 'restricted'] as const;
export type HolidayKind = (typeof HOLIDAY_KINDS)[number];

/** Sunday. The one weekly off this platform assumes absent a per-branch rule. */
export const WEEKLY_OFF_DAY = 0;

function ymd(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

/**
 * Inclusive working-day count between two dates: every calendar day minus
 * Sundays and holidays. `holidayDates` is a set of `YYYY-MM-DD` strings, so
 * the caller decides which year's list applies rather than this function
 * guessing from the range.
 *
 * This is what leave.ts's day count feeds into instead of a raw calendar
 * span — a five-day leave request that includes a Sunday and a national
 * holiday costs three days of balance, not five.
 */
export function workingDayCount(start: Date, end: Date, holidayDates: ReadonlySet<string>): number {
  if (end < start) return 0;
  let count = 0;
  const cursor = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate()));
  const last = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate()));
  while (cursor <= last) {
    if (cursor.getUTCDay() !== WEEKLY_OFF_DAY && !holidayDates.has(ymd(cursor))) count += 1;
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return Math.max(1, count);
}

// ---------------------------------------------------------------------------
// Leave carry-forward, lapse and encashment
// ---------------------------------------------------------------------------

/** What a leave type's balance becomes at FY close: carried up to the cap, the rest lapsed. */
export function carryForwardSplit(balance: number, cap: number): { carried: number; lapsed: number } {
  const carried = Math.max(0, Math.min(balance, cap));
  const lapsed = Math.max(0, balance - carried);
  return { carried, lapsed };
}

/** Encashment amount: basic/26 × days — the standard per-day wage this platform uses throughout §14 for pro-rated pay. */
export function encashmentAmount(basicPay: number, days: number): number {
  return round2((basicPay / 26) * days);
}

// ---------------------------------------------------------------------------
// Working hours and overtime
// ---------------------------------------------------------------------------

/** ISO 8601 week label: "2026-W37". */
export function isoWeekLabel(date: Date): string {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const dayNum = (d.getUTCDay() + 6) % 7; // Monday = 0
  d.setUTCDate(d.getUTCDate() - dayNum + 3); // nearest Thursday
  const firstThursday = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  const firstDayNum = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstDayNum + 3);
  const week = 1 + Math.round((d.getTime() - firstThursday.getTime()) / (7 * 86_400_000));
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

/** The Monday..Sunday UTC range an ISO week label spans. */
export function isoWeekRange(label: string): { start: Date; end: Date } {
  const [yearStr, weekStr] = label.split('-W');
  const year = Number(yearStr);
  const week = Number(weekStr);
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const jan4Day = (jan4.getUTCDay() + 6) % 7;
  const week1Monday = new Date(jan4.getTime() - jan4Day * 86_400_000);
  const start = new Date(week1Monday.getTime() + (week - 1) * 7 * 86_400_000);
  const end = new Date(start.getTime() + 6 * 86_400_000);
  return { start, end };
}

/** Overtime pay for the week: hours × 2 × basic/(26×8), the hourly rate an 8-hour statutory day implies. */
export function overtimeAmount(basicPay: number, otHours: number, multiplier = 2): number {
  const hourlyRate = basicPay / (26 * 8);
  return round2(hourlyRate * multiplier * otHours);
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

// ---------------------------------------------------------------------------
// POSH — Internal Committee composition
// ---------------------------------------------------------------------------

export const ICC_MEMBER_ROLES = ['presiding', 'member', 'external'] as const;
export type IccMemberRole = (typeof ICC_MEMBER_ROLES)[number];

export interface IccMemberFact {
  role: IccMemberRole;
  isWoman: boolean;
  /** Excluded from the active roster when true — a lapsed term is not a seat. */
  termEnded: boolean;
}

export interface IccValidation {
  presidingIsWoman: boolean;
  womenHalfOrMore: boolean;
  hasExternalMember: boolean;
  compliant: boolean;
  /** What is missing, phrased as a true statement about the current roster. */
  missing: string[];
}

/**
 * POSH Act Sec 4(2): the presiding officer must be a woman, at least half the
 * members must be women, and one member must be from an outside organisation
 * (an NGO or somebody familiar with the issue). Reported as true statements
 * about the roster rather than a bare pass/fail, per the plan's own
 * requirement.
 */
export function validateIccComposition(members: IccMemberFact[]): IccValidation {
  const active = members.filter((m) => !m.termEnded);
  const presiding = active.filter((m) => m.role === 'presiding');
  const presidingIsWoman = presiding.length > 0 && presiding.every((m) => m.isWoman);
  const women = active.filter((m) => m.isWoman).length;
  const womenHalfOrMore = active.length > 0 && women * 2 >= active.length;
  const hasExternalMember = active.some((m) => m.role === 'external');

  const missing: string[] = [];
  if (presiding.length === 0) missing.push('No presiding officer is appointed.');
  else if (!presidingIsWoman) missing.push('The presiding officer is not recorded as a woman.');
  if (!womenHalfOrMore) {
    missing.push(`Only ${women} of ${active.length} active members are women; at least half is required.`);
  }
  if (!hasExternalMember) missing.push('No external member (from an outside organisation) is on the committee.');
  if (active.length === 0) missing.push('The committee has no active members.');

  return {
    presidingIsWoman,
    womenHalfOrMore,
    hasExternalMember,
    compliant: presidingIsWoman && womenHalfOrMore && hasExternalMember && active.length > 0,
    missing,
  };
}

// ---------------------------------------------------------------------------
// POSH deadlines
// ---------------------------------------------------------------------------

const DAY_MS = 86_400_000;

/** POSH Act Sec 11(4): the inquiry completes within 90 days of the complaint. */
export function inquiryDueAt(receivedOn: Date): Date {
  return new Date(receivedOn.getTime() + 90 * DAY_MS);
}

/** POSH Act Sec 13(1): the report follows within 10 days of the inquiry closing. */
export function reportDueAt(inquiryClosedAt: Date): Date {
  return new Date(inquiryClosedAt.getTime() + 10 * DAY_MS);
}

// ---------------------------------------------------------------------------
// Disciplinary process
// ---------------------------------------------------------------------------

export const DISCIPLINARY_STATUSES = [
  'show_cause', 'reply_received', 'inquiry', 'decision', 'closed',
] as const;
export type DisciplinaryStatus = (typeof DISCIPLINARY_STATUSES)[number];

export const DISCIPLINARY_OUTCOMES = ['warning', 'suspension', 'termination', 'none'] as const;
export type DisciplinaryOutcome = (typeof DISCIPLINARY_OUTCOMES)[number];

/** Show-cause reply window: 7 days. */
export function replyDueAt(showCauseIssuedAt: Date): Date {
  return new Date(showCauseIssuedAt.getTime() + 7 * DAY_MS);
}

// ---------------------------------------------------------------------------
// Letters
// ---------------------------------------------------------------------------

export const HR_LETTER_KINDS = [
  'offer', 'appointment', 'confirmation', 'relieving', 'experience', 'warning',
] as const;
export type HrLetterKind = (typeof HR_LETTER_KINDS)[number];

export interface LetterFacts {
  employeeName: string;
  designation?: string | null;
  legalEntity: string;
  hireEffectiveDate?: string | null;
  lastWorkingDay?: string | null;
  separationType?: string | null;
  issuedOn: string;
  number: string;
}

/**
 * The letter body, built from the facts rather than typed fresh each time —
 * the snapshot a HrLetter carries. Plain text: what is issued is a document,
 * not a rendering decision this package should make.
 */
export function buildLetterBody(kind: HrLetterKind, facts: LetterFacts): string {
  const { employeeName, designation, legalEntity, hireEffectiveDate, lastWorkingDay, issuedOn, number } = facts;
  switch (kind) {
    case 'appointment':
      return (
        `${legalEntity}\n\nLetter of Appointment — ${number}\nDated ${issuedOn}\n\n` +
        `Dear ${employeeName},\n\nFurther to your acceptance of our offer, we are pleased to confirm your ` +
        `appointment${designation ? ` as ${designation}` : ''} with effect from ${hireEffectiveDate ?? 'the date agreed'}. ` +
        `Your terms of employment are as discussed and recorded separately.\n\nWelcome to ${legalEntity}.`
      );
    case 'relieving':
      return (
        `${legalEntity}\n\nRelieving Letter — ${number}\nDated ${issuedOn}\n\n` +
        `This is to certify that ${employeeName}${designation ? `, ${designation},` : ''} stood relieved from the ` +
        `services of ${legalEntity} with effect from ${lastWorkingDay ?? issuedOn}, consequent to ` +
        `${facts.separationType ?? 'separation'}. All dues, if any, have been settled per the full-and-final process.`
      );
    case 'experience':
      return (
        `${legalEntity}\n\nExperience Certificate — ${number}\nDated ${issuedOn}\n\n` +
        `This is to certify that ${employeeName} was employed with ${legalEntity}` +
        `${designation ? ` as ${designation}` : ''} from ${hireEffectiveDate ?? '—'} to ${lastWorkingDay ?? issuedOn}. ` +
        `Their conduct and performance during this period were satisfactory.`
      );
    case 'confirmation':
      return (
        `${legalEntity}\n\nConfirmation Letter — ${number}\nDated ${issuedOn}\n\n` +
        `Dear ${employeeName},\n\nYour probation with ${legalEntity} is complete and your employment stands confirmed ` +
        `with effect from ${issuedOn}.`
      );
    case 'warning':
      return (
        `${legalEntity}\n\nLetter of Warning — ${number}\nDated ${issuedOn}\n\n` +
        `Dear ${employeeName},\n\nThis letter records a formal warning arising from the disciplinary matter noted ` +
        `against your record. Repetition of the conduct concerned may attract further action.`
      );
    case 'offer':
    default:
      return (
        `${legalEntity}\n\nOffer Letter — ${number}\nDated ${issuedOn}\n\n` +
        `Dear ${employeeName},\n\nWe are pleased to offer you employment${designation ? ` as ${designation}` : ''} ` +
        `with ${legalEntity}, subject to the terms discussed.`
      );
  }
}

// ---------------------------------------------------------------------------
// Statutory registers
// ---------------------------------------------------------------------------

/** Escapes a value for a CSV cell — quoted whenever it carries a comma, quote or newline. */
export function csvCell(value: string | number | null | undefined): string {
  const s = value === null || value === undefined ? '' : String(value);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// `toCsv` lives in ./books.ts and is shared by every register export.

export const REGISTER_NAMES: Record<'wages' | 'leave' | 'muster-roll' | 'employees', string> = {
  wages: 'Register of Wages',
  leave: 'Register of Leave',
  'muster-roll': 'Muster Roll',
  employees: 'Register of Employees (Form Q)',
};
