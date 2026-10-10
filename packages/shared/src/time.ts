/**
 * Indian statutory periods are civil periods in IST, not UTC.
 *
 * An instant between midnight and 05:30 UTC on the first day of a month is
 * already in the next month for an Indian business.
 */
export const IST = 'Asia/Kolkata' as const;

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

/**
 * The calendar year a financial year starts in: 2026 for FY2026-27. Starts on
 * 1 April IST, so 00:30 IST on 1 April is already the new year.
 */
export function istFinancialYearStart(date: Date): number {
  const { year, month } = istParts(date);
  return month >= 4 ? year : year - 1;
}

export function istFinancialYear(date: Date): string {
  const start = istFinancialYearStart(date);
  return `FY${start}-${String((start + 1) % 100).padStart(2, '0')}`;
}

export function istPeriodOf(date: Date): { month: string; financialYear: string } {
  return { month: istMonthKey(date), financialYear: istFinancialYear(date) };
}
