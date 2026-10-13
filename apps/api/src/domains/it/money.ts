/**
 * The rupee side of the IT money columns (MONEY-S8-IT). The columns are paise;
 * a legacy field keeps the rupee number it has always carried, so the wire
 * stays unchanged for one wave. The helpers live in domains/money.ts (moved for
 * MONEY-S8-HCM, which needs them too) and are re-exported here so the IT call
 * sites read as they did.
 */

export { minorToRupees, withNumberMinor } from '../money.js';
