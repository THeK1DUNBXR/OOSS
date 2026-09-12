/**
 * The books (bounded context `fin`) — Canon §15.
 *
 * The arithmetic, kept pure and here rather than in the API, for the same
 * reason the lifecycle machines are: a surface showing a depreciation schedule
 * and a service posting one must agree, and the only way to guarantee that is
 * for there to be one of them.
 *
 * Everything below is rupee arithmetic for an Indian private limited company:
 * GST that splits or does not depending on which side of a state line the
 * customer is, written-down-value depreciation because that is what the tax
 * computation uses, and a financial year that starts in April.
 */

// ---------------------------------------------------------------------------
// Divisions — the cut every figure in this company is read by
// ---------------------------------------------------------------------------

export const DIVISIONS = ['software', 'skill', 'education', 'shared'] as const;
export type Division = (typeof DIVISIONS)[number];

export const DIVISION_LABELS: Record<Division, string> = {
  software: 'Software',
  skill: 'Skill Development',
  education: 'Education',
  shared: 'Shared / Corporate',
};

export function isDivision(value: string | null | undefined): value is Division {
  return typeof value === 'string' && (DIVISIONS as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// Ledger vocabulary
// ---------------------------------------------------------------------------

export const CATEGORY_KINDS = [
  'income', 'expense', 'asset_purchase', 'transfer', 'tax', 'drawings', 'equity',
] as const;
export type CategoryKind = (typeof CATEGORY_KINDS)[number];

/**
 * Kinds that move cash without being trading performance.
 *
 * A transfer between the company's own accounts is not income on one side and
 * expense on the other; capital put in by the founders is funding, not
 * revenue; money taken out is not a cost of doing business. Counting any of
 * them in the profit and loss would make a funded month look profitable, which
 * is the single most misleading thing a founder's dashboard can do.
 */
export const NON_TRADING_KINDS: CategoryKind[] = ['transfer', 'equity', 'drawings'];

export function isTrading(kind: string | null | undefined): boolean {
  return !NON_TRADING_KINDS.includes((kind ?? 'expense') as CategoryKind);
}

/**
 * How a cost behaves over a year, which is what makes a cash forecast a
 * forecast rather than a guess: rent recurs whatever happens, program costs
 * follow delivery, and an audit fee lands once.
 */
export const CATEGORY_BEHAVIOURS = ['recurring_fixed', 'variable', 'one_time', 'annual'] as const;
export type CategoryBehaviour = (typeof CATEGORY_BEHAVIOURS)[number];

export const TRANSACTION_SOURCES = [
  'manual', 'bank_import', 'payroll', 'invoice', 'vendor_bill', 'recurring', 'asset', 'loan',
] as const;
export type TransactionSource = (typeof TRANSACTION_SOURCES)[number];

export const LEDGER_GROUPS = ['asset', 'liability', 'equity'] as const;
export type LedgerGroup = (typeof LEDGER_GROUPS)[number];

// ---------------------------------------------------------------------------
// Periods. The Indian financial year runs April to March.
// ---------------------------------------------------------------------------

/** `YYYY-MM` for a date, in UTC. */
export function monthKey(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

export function monthRange(period: string): { from: Date; to: Date } {
  const [year, month] = period.split('-').map(Number);
  return { from: new Date(Date.UTC(year, month - 1, 1)), to: new Date(Date.UTC(year, month, 1)) };
}

/** The label a financial year is referred to by: FY2026-27. */
export function financialYearOf(d: Date): string {
  const y = d.getUTCFullYear();
  const start = d.getUTCMonth() >= 3 ? y : y - 1;
  return `FY${start}-${String((start + 1) % 100).padStart(2, '0')}`;
}

export function financialYearRange(fyStartYear: number): { from: Date; to: Date } {
  return { from: new Date(Date.UTC(fyStartYear, 3, 1)), to: new Date(Date.UTC(fyStartYear + 1, 3, 1)) };
}

/** The `count` months ending with `endPeriod`, oldest first. */
export function monthsBack(endPeriod: string, count: number): string[] {
  const [year, month] = endPeriod.split('-').map(Number);
  const out: string[] = [];
  for (let i = count - 1; i >= 0; i -= 1) {
    const d = new Date(Date.UTC(year, month - 1 - i, 1));
    out.push(monthKey(d));
  }
  return out;
}

// ---------------------------------------------------------------------------
// GST
// ---------------------------------------------------------------------------

export interface GstLineInput {
  /** Line value before tax. */
  taxableValue: number;
  /** Percentage: 0, 5, 12, 18, 28. */
  gstRate: number;
}

export interface GstBreakdown {
  taxableValue: number;
  cgst: number;
  sgst: number;
  igst: number;
  tax: number;
  total: number;
  roundOff: number;
  grandTotal: number;
}

/** Rupees, to two places, without the drift of repeated float addition. */
export function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/**
 * Splits GST across a set of lines.
 *
 * Within the state the tax is halved into CGST and SGST; across a state line
 * it is a single IGST. That is not a presentation choice — they are different
 * taxes, collected by different governments, and an invoice that shows the
 * wrong pair is wrong rather than merely untidy.
 *
 * The split is computed per line and then summed, because a single invoice can
 * carry an 18% service and a 5% good, and halving the invoice total would
 * misstate both.
 */
export function computeGst(lines: GstLineInput[], interState: boolean): GstBreakdown {
  let taxableValue = 0;
  let cgst = 0;
  let sgst = 0;
  let igst = 0;

  for (const line of lines) {
    const value = round2(line.taxableValue);
    const tax = round2((value * line.gstRate) / 100);
    taxableValue = round2(taxableValue + value);

    if (interState) {
      igst = round2(igst + tax);
    } else {
      // Half each, with the odd paisa going to CGST so the two halves still
      // sum to the tax rather than to a rupee either side of it.
      const half = round2(tax / 2);
      cgst = round2(cgst + half);
      sgst = round2(sgst + round2(tax - half));
    }
  }

  const tax = round2(cgst + sgst + igst);
  const total = round2(taxableValue + tax);
  // An invoice is presented to the nearest rupee, and the difference is
  // carried explicitly rather than absorbed — otherwise the ledger and the
  // printed document disagree by paise nobody can account for.
  const grandTotal = Math.round(total);
  const roundOff = round2(grandTotal - total);

  return { taxableValue, cgst, sgst, igst, tax, total, roundOff, grandTotal };
}

/**
 * Whether a supply crosses a state line, from the two GSTINs' state codes.
 *
 * The first two digits of a GSTIN are the state. If the customer has no GSTIN
 * — an unregistered buyer — the place of supply is what decides, and this
 * returns null so the caller has to say rather than guess.
 */
export function isInterState(supplierGstin: string | null, customerGstin: string | null): boolean | null {
  if (!supplierGstin || !customerGstin) return null;
  if (supplierGstin.length < 2 || customerGstin.length < 2) return null;
  return supplierGstin.slice(0, 2) !== customerGstin.slice(0, 2);
}

export const GST_RATES = [0, 5, 12, 18, 28] as const;

// ---------------------------------------------------------------------------
// Registrations and places of supply
// ---------------------------------------------------------------------------

/**
 * The state codes a GSTIN begins with, and a place of supply is named by.
 *
 * Held as codes rather than names because that is what the tax is decided from:
 * two GSTINs whose first two digits differ are an inter-state supply, whatever
 * anybody calls the states. A return also wants the code and the name together,
 * in `07-Delhi` form, which is the one place the name is load-bearing.
 */
export const GST_STATE_CODES: Record<string, string> = {
  '01': 'Jammu and Kashmir',
  '02': 'Himachal Pradesh',
  '03': 'Punjab',
  '04': 'Chandigarh',
  '05': 'Uttarakhand',
  '06': 'Haryana',
  '07': 'Delhi',
  '08': 'Rajasthan',
  '09': 'Uttar Pradesh',
  '10': 'Bihar',
  '11': 'Sikkim',
  '12': 'Arunachal Pradesh',
  '13': 'Nagaland',
  '14': 'Manipur',
  '15': 'Mizoram',
  '16': 'Tripura',
  '17': 'Meghalaya',
  '18': 'Assam',
  '19': 'West Bengal',
  '20': 'Jharkhand',
  '21': 'Odisha',
  '22': 'Chhattisgarh',
  '23': 'Madhya Pradesh',
  '24': 'Gujarat',
  '25': 'Daman and Diu',
  '26': 'Dadra and Nagar Haveli and Daman and Diu',
  '27': 'Maharashtra',
  '28': 'Andhra Pradesh (old)',
  '29': 'Karnataka',
  '30': 'Goa',
  '31': 'Lakshadweep',
  '32': 'Kerala',
  '33': 'Tamil Nadu',
  '34': 'Puducherry',
  '35': 'Andaman and Nicobar Islands',
  '36': 'Telangana',
  '37': 'Andhra Pradesh',
  '38': 'Ladakh',
  '96': 'Other Country',
  '97': 'Other Territory',
};

export function stateNameFor(code: string | null | undefined): string | null {
  if (!code) return null;
  return GST_STATE_CODES[code.padStart(2, '0')] ?? null;
}

/** `07-Delhi`, which is the form a return wants a place of supply in. */
export function placeOfSupplyLabel(code: string | null | undefined): string | null {
  if (!code) return null;
  const padded = code.padStart(2, '0');
  const name = GST_STATE_CODES[padded];
  return name ? `${padded}-${name}` : padded;
}

export function stateCodeOf(gstin: string | null | undefined): string | null {
  if (!gstin || gstin.length < 2) return null;
  const code = gstin.slice(0, 2);
  return GST_STATE_CODES[code] ? code : null;
}

const GSTIN_PATTERN = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}[Z]{1}[0-9A-Z]{1}$/;
const GSTIN_ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';

/**
 * Whether a GSTIN is a GSTIN.
 *
 * Shape, a real state code, and the check digit — all three, because the first
 * two alone accept a typo in the middle of the PAN, and a return filed against a
 * mistyped customer registration is rejected by the portal weeks later with
 * nothing to say which invoice caused it. Validating at entry is the difference
 * between a corrected field and a reconciliation.
 */
export function isValidGstin(value: string | null | undefined): boolean {
  if (!value) return false;
  const gstin = value.trim().toUpperCase();
  if (gstin.length !== 15) return false;
  if (!GSTIN_PATTERN.test(gstin)) return false;
  if (!GST_STATE_CODES[gstin.slice(0, 2)]) return false;
  return gstinCheckDigit(gstin.slice(0, 14)) === gstin[14];
}

/**
 * The check digit for the first fourteen characters.
 *
 * The published algorithm: each character's value is multiplied by an
 * alternating factor of 1 and 2, the product is folded back into base 36, the
 * folded digits are summed, and the check character is what takes that sum to a
 * multiple of 36.
 */
export function gstinCheckDigit(first14: string): string | null {
  if (first14.length !== 14) return null;
  let sum = 0;
  for (let i = 0; i < 14; i += 1) {
    const value = GSTIN_ALPHABET.indexOf(first14[i]);
    if (value < 0) return null;
    const product = value * (i % 2 === 0 ? 1 : 2);
    sum += Math.floor(product / 36) + (product % 36);
  }
  return GSTIN_ALPHABET[(36 - (sum % 36)) % 36];
}

/**
 * Which GSTR-1 table a supply belongs in.
 *
 * A registered customer is B2B and is reported invoice by invoice with their
 * GSTIN; an unregistered one is B2C and is reported as a rate-wise total. That
 * is not a presentation difference — it decides whether the customer can claim
 * the credit, so getting it from the presence of a validated GSTIN rather than
 * from a tick box is the point.
 */
export function supplyTypeOf(customerGstin: string | null | undefined): 'b2b' | 'b2c' {
  return isValidGstin(customerGstin) ? 'b2b' : 'b2c';
}

// ---------------------------------------------------------------------------
// What is actually paid
// ---------------------------------------------------------------------------

export interface GstHeads {
  cgst: number;
  sgst: number;
  igst: number;
}

export interface GstSetOff {
  /** Credit used against each head. */
  utilised: GstHeads;
  /** What is left to pay in cash, after credit. */
  payable: GstHeads;
  /** Credit still unused, carried to the next period. */
  carriedForward: GstHeads;
  totalPayable: number;
  totalUtilised: number;
}

/**
 * Sets input credit off against output tax, in the statutory order, and says
 * what is left to pay in cash.
 *
 * The order matters and is not intuitive: IGST credit must be used against IGST
 * first, and only then may spill over to CGST and SGST; CGST credit may only be
 * used against CGST, and SGST credit only against SGST. Netting the totals
 * instead — which is what a single "output minus input" figure does — produces a
 * number that is too small whenever the mix differs, and the shortfall is
 * discovered as interest.
 */
export function setOffInputCredit(output: GstHeads, credit: GstHeads): GstSetOff {
  const out = { cgst: round2(output.cgst), sgst: round2(output.sgst), igst: round2(output.igst) };
  const cr = { cgst: round2(credit.cgst), sgst: round2(credit.sgst), igst: round2(credit.igst) };
  const utilised: GstHeads = { cgst: 0, sgst: 0, igst: 0 };

  // IGST credit: against IGST first, then CGST, then SGST.
  let igstCredit = cr.igst;
  const igstAgainstIgst = Math.min(out.igst, igstCredit);
  out.igst = round2(out.igst - igstAgainstIgst);
  igstCredit = round2(igstCredit - igstAgainstIgst);

  const igstAgainstCgst = Math.min(out.cgst, igstCredit);
  out.cgst = round2(out.cgst - igstAgainstCgst);
  igstCredit = round2(igstCredit - igstAgainstCgst);

  const igstAgainstSgst = Math.min(out.sgst, igstCredit);
  out.sgst = round2(out.sgst - igstAgainstSgst);
  igstCredit = round2(igstCredit - igstAgainstSgst);

  utilised.igst = round2(igstAgainstIgst + igstAgainstCgst + igstAgainstSgst);

  // CGST credit against CGST only; SGST credit against SGST only.
  const cgstUsed = Math.min(out.cgst, cr.cgst);
  out.cgst = round2(out.cgst - cgstUsed);
  utilised.cgst = cgstUsed;

  const sgstUsed = Math.min(out.sgst, cr.sgst);
  out.sgst = round2(out.sgst - sgstUsed);
  utilised.sgst = sgstUsed;

  const carriedForward: GstHeads = {
    cgst: round2(cr.cgst - cgstUsed),
    sgst: round2(cr.sgst - sgstUsed),
    igst: round2(igstCredit),
  };

  return {
    utilised,
    payable: out,
    carriedForward,
    totalPayable: round2(out.cgst + out.sgst + out.igst),
    totalUtilised: round2(utilised.cgst + utilised.sgst + utilised.igst),
  };
}

/**
 * What is still owed on an obligation, and whether a stated payment settles it.
 *
 * One function because the same three numbers are asked for by the invoice
 * document, the receivables projection, the overdue detector and the counter
 * where somebody is taking a part payment — and four independently written
 * subtractions is how a screen comes to disagree with a ledger.
 */
export function outstandingOf(payable: number, allocated: number, creditNoted = 0): number {
  return round2(Math.max(payable - allocated - creditNoted, 0));
}

/**
 * Which of the three things the document should say, given what is being
 * collected now against the whole.
 *
 * Derived rather than asked, because a clerk choosing "full payment" and typing
 * a smaller figure produces a document that contradicts itself, and the customer
 * is the one who finds out.
 */
export function paymentTypeFor(payable: number, payingNow: number): 'full' | 'part' | 'credit' {
  const now = round2(payingNow);
  if (now <= 0) return 'credit';
  if (now >= round2(payable) - 0.001) return 'full';
  return 'part';
}

/**
 * What an invoice is actually payable for.
 *
 * `grandTotal` is the figure the document was raised at, tax and rounding
 * included, and it is the right answer whenever it is set. It is zero on rows
 * raised before tax was priced at creation, and for those the sum of the lines
 * is the only figure there is — so the fallback is not defensive, it is the
 * correct reading of an older invoice, and it keeps a seven-month-old ledger
 * from restating itself the day this code ships.
 */
export function invoicePayable(grandTotal: number | null | undefined, lineTotal: number): number {
  return grandTotal && grandTotal > 0 ? round2(grandTotal) : round2(lineTotal);
}

// ---------------------------------------------------------------------------
// Rupees, in words
// ---------------------------------------------------------------------------

const ONES = [
  '', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten',
  'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen',
  'Eighteen', 'Nineteen',
];
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];

function twoDigits(n: number): string {
  if (n < 20) return ONES[n];
  const t = TENS[Math.floor(n / 10)];
  const o = ONES[n % 10];
  return o ? `${t} ${o}` : t;
}

/**
 * A number in the Indian system: crore, lakh, thousand, hundred.
 *
 * Not a formatting nicety. An invoice carries the amount in words because that
 * is what settles a dispute about a smudged digit, and the grouping is lakhs and
 * crores rather than millions — "Eleven Thousand Eight Hundred" is what a
 * customer here reads, and a western grouping of the same number reads as a
 * mistake.
 */
export function amountInWords(value: number): string {
  const rounded = round2(Math.abs(value));
  const rupees = Math.floor(rounded);
  const paise = Math.round((rounded - rupees) * 100);

  const parts: string[] = [];
  const push = (n: number, label: string) => {
    if (n > 0) parts.push(`${twoDigits(n)} ${label}`);
  };

  push(Math.floor(rupees / 10_000_000), 'Crore');
  push(Math.floor((rupees % 10_000_000) / 100_000), 'Lakh');
  push(Math.floor((rupees % 100_000) / 1_000), 'Thousand');
  push(Math.floor((rupees % 1_000) / 100), 'Hundred');

  const last = rupees % 100;
  if (last > 0) {
    if (parts.length > 0) parts.push('and');
    parts.push(twoDigits(last));
  }

  const sign = value < 0 ? 'Minus ' : '';
  const whole = parts.length ? parts.join(' ') : 'Zero';
  const paisePart = paise > 0 ? ` and ${twoDigits(paise)} Paise` : '';
  return `${sign}Rupees ${whole}${paisePart} Only`;
}

// ---------------------------------------------------------------------------
// Depreciation
// ---------------------------------------------------------------------------

export interface DepreciationPeriod {
  period: string;
  opening: number;
  charge: number;
  closing: number;
}

export interface DepreciationInput {
  cost: number;
  salvageValue: number;
  usefulLifeMonths: number;
  purchaseDate: Date;
  /** `straight_line`, or `wdv` — which is what the Indian tax computation uses. */
  method: 'straight_line' | 'wdv';
  /** Annual percentage, for `wdv` only. */
  wdvRate?: number;
}

/**
 * The whole schedule, month by month.
 *
 * Computed on demand rather than stored: correcting a useful life then fixes
 * every future period at once, instead of leaving a table somebody has to
 * remember to regenerate.
 */
export function depreciationSchedule(input: DepreciationInput): DepreciationPeriod[] {
  const out: DepreciationPeriod[] = [];
  if (input.usefulLifeMonths <= 0 || input.cost <= 0) return out;

  const depreciable = Math.max(0, round2(input.cost - input.salvageValue));
  let carrying = input.cost;

  for (let i = 0; i < input.usefulLifeMonths; i += 1) {
    const d = new Date(
      Date.UTC(input.purchaseDate.getUTCFullYear(), input.purchaseDate.getUTCMonth() + i, 1),
    );
    const opening = carrying;

    let charge: number;
    if (input.method === 'wdv') {
      const monthlyRate = (input.wdvRate ?? 0) / 100 / 12;
      charge = round2(Math.max(0, opening - input.salvageValue) * monthlyRate);
    } else {
      charge = round2(depreciable / input.usefulLifeMonths);
    }

    // Never write below the salvage value, and let the final period absorb the
    // rounding rather than leaving a few paise stranded forever.
    const floor = input.salvageValue;
    if (opening - charge < floor) charge = round2(opening - floor);
    if (charge < 0) charge = 0;

    carrying = round2(opening - charge);
    out.push({ period: monthKey(d), opening, charge, closing: carrying });

    if (carrying <= floor) break;
  }

  return out;
}

/** What an asset is carried at on a date, from the same schedule. */
export function bookValueAt(input: DepreciationInput, asOf: Date): number {
  const schedule = depreciationSchedule(input);
  const key = monthKey(asOf);
  let value = input.cost;
  for (const row of schedule) {
    if (row.period > key) break;
    value = row.closing;
  }
  return value;
}

// ---------------------------------------------------------------------------
// Loans
// ---------------------------------------------------------------------------

export interface AmortisationPeriod {
  period: string;
  opening: number;
  instalment: number;
  interest: number;
  principal: number;
  closing: number;
}

/** The level monthly instalment for a reducing-balance loan. */
export function emi(principal: number, annualRatePercent: number, tenureMonths: number): number {
  if (tenureMonths <= 0) return 0;
  const r = annualRatePercent / 100 / 12;
  // A zero-interest loan is just the principal divided by the term; the
  // general formula divides by zero there.
  if (r === 0) return round2(principal / tenureMonths);
  const factor = Math.pow(1 + r, tenureMonths);
  return round2((principal * r * factor) / (factor - 1));
}

export function amortisationSchedule(input: {
  principal: number;
  annualRate: number;
  tenureMonths: number;
  startDate: Date;
}): AmortisationPeriod[] {
  const out: AmortisationPeriod[] = [];
  if (input.tenureMonths <= 0 || input.principal <= 0) return out;

  const instalment = emi(input.principal, input.annualRate, input.tenureMonths);
  const r = input.annualRate / 100 / 12;
  let balance = input.principal;

  for (let i = 0; i < input.tenureMonths; i += 1) {
    const d = new Date(Date.UTC(input.startDate.getUTCFullYear(), input.startDate.getUTCMonth() + i, 1));
    const opening = balance;
    const interest = round2(opening * r);
    // The last instalment clears whatever is left, so rounding across the term
    // cannot leave a balance outstanding on a loan that has been repaid.
    let principalPart = round2(instalment - interest);
    if (i === input.tenureMonths - 1 || principalPart > opening) principalPart = opening;

    balance = round2(opening - principalPart);
    out.push({
      period: monthKey(d),
      opening,
      instalment: round2(principalPart + interest),
      interest,
      principal: principalPart,
      closing: balance,
    });

    if (balance <= 0) break;
  }

  return out;
}

/** What is still owed on a date. */
export function loanBalanceAt(
  input: { principal: number; annualRate: number; tenureMonths: number; startDate: Date },
  asOf: Date,
): number {
  const schedule = amortisationSchedule(input);
  const key = monthKey(asOf);
  let balance = input.principal;
  for (const row of schedule) {
    if (row.period > key) break;
    balance = row.closing;
  }
  return balance;
}

// ---------------------------------------------------------------------------
// Runway
// ---------------------------------------------------------------------------

/**
 * How long the cash lasts at the current burn.
 *
 * Returns null when the company is not burning — profitable or break-even —
 * because "infinite runway" is a number that reads as a fact and is not one.
 * A surface should say "not burning" rather than print ∞.
 *
 * Overdrawn returns 0, not a negative. A negative runway would render as
 * "-4.2 months", which reads as a quantity of time and is not one: the money
 * has already run out, and how far past the line the company is is a different
 * number with a different name.
 */
export function runwayMonths(cashOnHand: number, monthlyNetBurn: number): number | null {
  if (monthlyNetBurn <= 0) return null;
  if (cashOnHand <= 0) return 0;
  return round2(cashOnHand / monthlyNetBurn);
}
