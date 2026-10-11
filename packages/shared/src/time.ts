/**
 * Indian statutory periods are civil periods in IST, not UTC.
 *
 * An instant between midnight and 05:30 UTC on the first day of a month is
 * already in the next month for an Indian business.
 */
export const IST = 'Asia/Kolkata' as const;

const IST_OFFSET_MS = (5 * 60 + 30) * 60_000;

const formatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: IST,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

function istParts(date: Date): { year: number; month: number; day: number } {
  const values = Object.fromEntries(formatter.formatToParts(date).map(({ type, value }) => [type, value]));
  return { year: Number(values.year), month: Number(values.month), day: Number(values.day) };
}

export function istMonthKey(date: Date): string {
  const { year, month } = istParts(date);
  return `${year}-${String(month).padStart(2, '0')}`;
}

/** The IST calendar year and month (1-12) of an instant. */
export function istYearMonth(date: Date): { year: number; month: number } {
  const { year, month } = istParts(date);
  return { year, month };
}

/**
 * The IST calendar date as YYYY-MM-DD. Date-only columns (`@db.Date`) compare
 * against this, not against the instant, so a rule effective on 1 April is in
 * force from 00:00 IST on 1 April, not from 05:30.
 */
export function istDateKey(date: Date): string {
  const { year, month, day } = istParts(date);
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/**
 * The IST civil date of an instant, stored the way a `@db.Date` column and the
 * journal's entry_date hold it: UTC midnight of that calendar date. Comparing a
 * date column with the raw instant reads 00:00 to 05:30 IST on a day as the
 * day before, which moves an entry into the previous period.
 */
export function istCivilDay(date: Date): Date {
  return new Date(`${istDateKey(date)}T00:00:00.000Z`);
}

/**
 * Minutes since IST midnight for an instant: the wall-clock reading a punch
 * or a shift's HH:MM is compared against. IST has no DST, so a fixed offset
 * is exact; the double modulo keeps pre-epoch instants in range.
 */
export function istMinuteOfDay(date: Date): number {
  const dayMs = 86_400_000;
  const msIntoIstDay = (((date.getTime() + IST_OFFSET_MS) % dayMs) + dayMs) % dayMs;
  return Math.floor(msIntoIstDay / 60_000);
}

/**
 * The calendar year a financial year starts in: 2026 for FY2026-27. Starts on
 * 1 April IST, so 00:30 IST on 1 April is already the new year.
 */
export function istFinancialYearStart(date: Date): number {
  const { year, month } = istParts(date);
  return month >= 4 ? year : year - 1;
}

/**
 * The instant IST midnight starts on a civil date. Period and FY boundaries
 * are IST midnights; `Date.UTC(y, m, d)` is 05:30 IST, which puts the first
 * five and a half hours of a new period into the old one.
 */
export function istMidnight(year: number, month1: number, day: number): Date {
  return new Date(Date.UTC(year, month1 - 1, day) - IST_OFFSET_MS);
}

/**
 * The instant the IST civil day containing `date` begins. A daily bucket is
 * keyed by this, so a run at 19:00Z on 11 October is the 12 October bucket:
 * 00:30 IST on the 12th, and its midnight is 18:30Z on the 11th.
 */
export function istDayStart(date: Date): Date {
  const { year, month, day } = istParts(date);
  return istMidnight(year, month, day);
}

/** The last millisecond of an IST civil date, for inclusive "on or before" deadlines. */
export function istEndOfDay(year: number, month1: number, day: number): Date {
  return new Date(istMidnight(year, month1, day + 1).getTime() - 1);
}

export function istFinancialYear(date: Date): string {
  const start = istFinancialYearStart(date);
  return `FY${start}-${String((start + 1) % 100).padStart(2, '0')}`;
}

export function istPeriodOf(date: Date): { month: string; financialYear: string } {
  return { month: istMonthKey(date), financialYear: istFinancialYear(date) };
}
