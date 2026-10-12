/**
 * The units a threshold can carry. The migration 20261013160000_threshold_minor
 * refuses a unit this list does not name, so a new unit changes this list and
 * that migration's list in the same change.
 *
 * Currency is the only unit held as paise (valueMinor, bigint). Every other unit
 * is a whole count of its own measure in valueInt: hours, days, a head count,
 * scoring points, seconds. Keeping money out of the count column is what stops
 * a rupee figure being compared as a day count, or the reverse.
 */
export const THRESHOLD_UNITS = ['currency', 'hours', 'days', 'count', 'points', 'seconds'] as const;

export type ThresholdUnit = (typeof THRESHOLD_UNITS)[number];

export function isCurrencyUnit(unit: string): boolean {
  return unit === 'currency';
}
