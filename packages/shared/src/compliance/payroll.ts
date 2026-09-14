/**
 * Compliance — payroll: types and pure arithmetic shared by API and web.
 *
 * Every rate here is an argument, never a literal, so the whole module stays
 * testable with no database in front of it: the caller reads the dated rate
 * table and hands the numbers in. See docs/plan/compliance.md workstream E.
 */

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

// ---------------------------------------------------------------------------
// PF / EPS / EDLI — EPF & MP Act 1952
// ---------------------------------------------------------------------------

export interface PfRates {
  employeeRate: number;
  employerRate: number;
  epsRate: number;
  edliRate: number;
  adminRate: number;
  wageCeiling: number;
  voluntary?: boolean;
}

export interface PfResult {
  pfWage: number;
  pfEmployee: number;
  epsEmployer: number;
  /** The employer's 12% minus the EPS share — what an ECR reports as A/c 1. */
  pfEmployer: number;
  edliEmployer: number;
  adminEmployer: number;
}

/**
 * Splits the employer's contribution into EPS (capped at the wage ceiling,
 * whatever the actual wage is) and the remainder — CMP-PAY-001.
 */
export function computePf(basicPlusDa: number, rates: PfRates): PfResult {
  const pfWage = rates.voluntary ? basicPlusDa : Math.min(basicPlusDa, rates.wageCeiling);
  const epsWage = Math.min(basicPlusDa, rates.wageCeiling); // EPS is always capped, voluntary or not
  const pfEmployee = round2(pfWage * rates.employeeRate);
  const epsEmployer = round2(epsWage * rates.epsRate);
  const employerTotal = round2(pfWage * rates.employerRate);
  const pfEmployer = round2(employerTotal - epsEmployer);
  const edliEmployer = round2(epsWage * rates.edliRate);
  const adminEmployer = round2(epsWage * rates.adminRate);
  return { pfWage, pfEmployee, epsEmployer, pfEmployer, edliEmployer, adminEmployer };
}

// ---------------------------------------------------------------------------
// ESI — ESI Act 1948
// ---------------------------------------------------------------------------

export interface EsiRates {
  employeeRate: number;
  employerRate: number;
  wageCeiling: number;
}

export interface EsiResult {
  esiEligible: boolean;
  esiEmployee: number;
  esiEmployer: number;
}

/** Eligibility is gross wage at or below the ceiling — never inferred elsewhere. */
export function esiEligible(gross: number, rates: EsiRates): boolean {
  return gross > 0 && gross <= rates.wageCeiling;
}

export function computeEsi(gross: number, rates: EsiRates, eligible = esiEligible(gross, rates)): EsiResult {
  if (!eligible) return { esiEligible: false, esiEmployee: 0, esiEmployer: 0 };
  return {
    esiEligible: true,
    esiEmployee: round2(gross * rates.employeeRate),
    esiEmployer: round2(gross * rates.employerRate),
  };
}

/** The two ESI contribution periods a pay period falls into. */
export function esiContributionPeriod(payPeriod: string): 'Apr-Sep' | 'Oct-Mar' {
  const month = Number(payPeriod.split('-')[1]);
  return month >= 4 && month <= 9 ? 'Apr-Sep' : 'Oct-Mar';
}

// ---------------------------------------------------------------------------
// Professional Tax — state slabs, half-yearly
// ---------------------------------------------------------------------------

export interface PtSlab {
  minGross: number;
  maxGross: number | null;
  halfYearlyAmount: number;
}

/** The half-yearly amount for `gross`, deducted monthly at one sixth of it. */
export function computePt(gross: number, slabs: PtSlab[]): number {
  const slab = slabs.find((s) => gross >= s.minGross && (s.maxGross === null || gross <= s.maxGross));
  if (!slab) return 0;
  return round2(slab.halfYearlyAmount / 6);
}

// ---------------------------------------------------------------------------
// Labour Welfare Fund — flat, once a year
// ---------------------------------------------------------------------------

export interface LwfRates {
  employeeAmount: number;
  employerAmount: number;
  dueMonth: number;
}

export interface LwfResult {
  lwfEmployee: number;
  lwfEmployer: number;
}

/** Only due in the month the table names — every other month is zero. */
export function computeLwf(payPeriod: string, rates: LwfRates): LwfResult {
  const month = Number(payPeriod.split('-')[1]);
  if (month !== rates.dueMonth) return { lwfEmployee: 0, lwfEmployer: 0 };
  return { lwfEmployee: rates.employeeAmount, lwfEmployer: rates.employerAmount };
}

// ---------------------------------------------------------------------------
// One instruction's statutory lines
// ---------------------------------------------------------------------------

export interface StatutoryComponents {
  basicPay: number;
  hra: number;
  otherAllowances: number;
}

export interface StatutoryTables {
  pf: PfRates;
  esi: EsiRates;
  pt: PtSlab[];
  lwf: LwfRates;
}

export interface StatutoryLinesResult {
  basicPay: number;
  hra: number;
  otherAllowances: number;
  pfEmployee: number;
  pfEmployer: number;
  epsEmployer: number;
  esiEmployee: number;
  esiEmployer: number;
  professionalTax: number;
  lwfEmployee: number;
  lwfEmployer: number;
  totalDeductions: number;
  netAmount: number;
}

/**
 * Every statutory line for one employee for one period, from gross plus the
 * dated tables. `engagementType === 'employee'` is the only case that gets
 * PF/ESI/PT/LWF at all — a contractor or consultant computes none of it
 * (CMP-PAY-004), which the caller enforces by not calling this for them.
 */
export function statutoryLines(
  gross: number,
  components: StatutoryComponents,
  tables: StatutoryTables,
  opts: { esiEligible?: boolean; payPeriod: string } = { payPeriod: '2026-01' },
): StatutoryLinesResult {
  const pf = computePf(components.basicPay, tables.pf);
  const eligible = opts.esiEligible ?? esiEligible(gross, tables.esi);
  const esi = computeEsi(gross, tables.esi, eligible);
  const pt = computePt(gross, tables.pt);
  const lwf = computeLwf(opts.payPeriod, tables.lwf);

  const totalDeductions = round2(pf.pfEmployee + esi.esiEmployee + pt + lwf.lwfEmployee);
  const netAmount = round2(gross - totalDeductions);

  return {
    basicPay: components.basicPay,
    hra: components.hra,
    otherAllowances: components.otherAllowances,
    pfEmployee: pf.pfEmployee,
    pfEmployer: pf.pfEmployer,
    epsEmployer: pf.epsEmployer,
    esiEmployee: esi.esiEmployee,
    esiEmployer: esi.esiEmployer,
    professionalTax: pt,
    lwfEmployee: lwf.lwfEmployee,
    lwfEmployer: lwf.lwfEmployer,
    totalDeductions,
    netAmount,
  };
}

// ---------------------------------------------------------------------------
// Gratuity — Payment of Gratuity Act 1972
// ---------------------------------------------------------------------------

/**
 * Years of service rounded the way the Act counts them: a completed year with
 * more than six months' service in the part-year counts as a whole year.
 */
export function gratuityYears(monthsOfService: number): number {
  const wholeYears = Math.floor(monthsOfService / 12);
  const remainderMonths = monthsOfService - wholeYears * 12;
  return remainderMonths > 6 ? wholeYears + 1 : wholeYears;
}

export interface GratuityResult {
  eligible: boolean;
  years: number;
  amount: number;
}

/**
 * 15 days' wages for every year of service, wages taken as basic + DA divided
 * by 26 working days. Eligibility is five completed years, unless the exit is
 * by death or disablement — the Act waives the floor there, so the caller
 * passes `exceptionApplies` rather than this function guessing the reason.
 */
export function gratuity(
  lastDrawnBasicPlusDa: number,
  monthsOfService: number,
  exceptionApplies = false,
): GratuityResult {
  const years = gratuityYears(monthsOfService);
  const eligible = exceptionApplies || years >= 5;
  if (!eligible) return { eligible: false, years, amount: 0 };
  const amount = round2((15 / 26) * lastDrawnBasicPlusDa * years);
  return { eligible: true, years, amount };
}

// ---------------------------------------------------------------------------
// Bonus — Payment of Bonus Act 1965
// ---------------------------------------------------------------------------

export const BONUS_ELIGIBILITY_CEILING = 21_000;
export const BONUS_CALCULATION_CEILING = 7_000;
export const BONUS_MIN_RATE = 0.0833; // 8.33%, the statutory floor

export interface BonusResult {
  eligible: boolean;
  amount: number;
}

/**
 * Eligible when basic (or the declared minimum wage, whichever is higher, per
 * the 2015 amendment) is at or below ₹21,000/month. The minimum-bonus floor —
 * 8.33% of basic, capped at whichever is lower of ₹7,000 or the minimum wage
 * for the category — is computed monthly here; annual bonus is the caller's
 * sum across the year.
 */
export function bonus(basicMonthly: number, eligible: boolean, minimumWageMonthly?: number): BonusResult {
  if (!eligible || basicMonthly > BONUS_ELIGIBILITY_CEILING) return { eligible: false, amount: 0 };
  const calcCeiling = minimumWageMonthly != null ? Math.min(BONUS_CALCULATION_CEILING, minimumWageMonthly) : BONUS_CALCULATION_CEILING;
  const wage = Math.min(basicMonthly, calcCeiling);
  return { eligible: true, amount: round2(wage * BONUS_MIN_RATE) };
}

// ---------------------------------------------------------------------------
// Leave encashment and notice recovery — pure helpers for offboarding
// ---------------------------------------------------------------------------

/** Per-day wage the Act and common practice both use for a 26-day month. */
export function perDayWage26(basicMonthly: number): number {
  return round2(basicMonthly / 26);
}

export function leaveEncashment(basicMonthly: number, encashableDays: number): number {
  return round2(perDayWage26(basicMonthly) * encashableDays);
}

/** Per-day wage against a 30-day month — the convention for notice recovery. */
export function noticeRecovery(basicMonthly: number, unservedDays: number): number {
  return round2((basicMonthly / 30) * unservedDays);
}
