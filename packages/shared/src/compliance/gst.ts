/**
 * Compliance — GST completion (docs/plan/compliance.md, workstream B).
 *
 * Types and pure arithmetic shared by the API and the web app. Statutory
 * figures (late-fee-per-day, the cap, the interest rate) are never constants
 * here — they come in as arguments, read from `GstRateTable` on the API side.
 */

import { round2 } from '../finance.js';

// ---------------------------------------------------------------------------
// Supply classification (CMP-GST-001)
// ---------------------------------------------------------------------------

export const SUPPLY_TYPES = ['taxable', 'nil', 'exempt', 'non_gst'] as const;
export type SupplyType = (typeof SUPPLY_TYPES)[number];

export function isNonTaxableSupply(supplyType: string | null | undefined): boolean {
  return supplyType === 'nil' || supplyType === 'exempt' || supplyType === 'non_gst';
}

/** The notification the education-services exemption is claimed under. */
export const EDUCATION_EXEMPTION_NOTIFICATION = '12/2017-CT(R) entry 66';

// ---------------------------------------------------------------------------
// Debit and credit note reasons (CMP-GST-003)
// ---------------------------------------------------------------------------

export const NOTE_REASON_CODES = [
  'rate_difference',
  'quantity_shortfall',
  'post_supply_price_revision',
  'other',
] as const;
export type NoteReasonCode = (typeof NOTE_REASON_CODES)[number];

export const NOTE_REASON_LABELS: Record<NoteReasonCode, string> = {
  rate_difference: 'Rate difference',
  quantity_shortfall: 'Quantity shortfall',
  post_supply_price_revision: 'Price revision after supply',
  other: 'Other',
};

// ---------------------------------------------------------------------------
// E-invoicing (CMP-GST-004)
// ---------------------------------------------------------------------------

export const EINVOICE_STATUSES = ['not_applicable', 'pending', 'registered', 'cancelled', 'failed'] as const;
export type EInvoiceStatus = (typeof EINVOICE_STATUSES)[number];

// ---------------------------------------------------------------------------
// GSTR-2B reconciliation
// ---------------------------------------------------------------------------

export const GSTR2B_MATCH_STATUSES = ['matched', 'missing_in_2b', 'missing_in_books', 'mismatch'] as const;
export type Gstr2bMatchStatus = (typeof GSTR2B_MATCH_STATUSES)[number];

/** One `b2b` document row from the GSTR-2B offline-utility JSON. */
export interface Gstr2bB2bRow {
  /** Supplier GSTIN. */
  ctin: string;
  /** Invoice number. */
  inum: string;
  /** Invoice date, `DD-MM-YYYY` as the portal writes it. */
  idt: string;
  /** Invoice value. */
  val: number;
  /** Line items, each carrying the taxable value and tax at that rate. */
  itms: Array<{ txval?: number; camt?: number; samt?: number; iamt?: number }>;
}

/** A vendor bill's own figures, as booked, for matching against a 2B row. */
export interface BookedBill {
  vendorBillId: string;
  vendorGstin: string | null;
  billNumber: string | null;
  taxableValue: number;
  taxAmount: number;
}

export interface Gstr2bMatchResult {
  vendorBillId: string | null;
  status: Gstr2bMatchStatus;
  difference: number;
  ctin: string | null;
  inum: string | null;
}

function lineTax(row: Gstr2bB2bRow): number {
  return round2(row.itms.reduce((s, i) => s + (i.camt ?? 0) + (i.samt ?? 0) + (i.iamt ?? 0), 0));
}

function lineTaxable(row: Gstr2bB2bRow): number {
  return round2(row.itms.reduce((s, i) => s + (i.txval ?? 0), 0));
}

/**
 * Matches booked vendor bills against the GSTR-2B rows for a period, on
 * vendor GSTIN + bill/invoice number — what Rule 36(4) keys eligible credit
 * to. Pure: no database, no dates beyond what is given.
 */
export function matchGstr2b(bills: BookedBill[], rows: Gstr2bB2bRow[]): Gstr2bMatchResult[] {
  const rowByKey = new Map<string, Gstr2bB2bRow>();
  for (const row of rows) {
    rowByKey.set(`${(row.ctin || '').toUpperCase()}:${(row.inum || '').trim().toUpperCase()}`, row);
  }
  const usedKeys = new Set<string>();
  const results: Gstr2bMatchResult[] = [];

  for (const bill of bills) {
    const key = `${(bill.vendorGstin || '').toUpperCase()}:${(bill.billNumber || '').trim().toUpperCase()}`;
    const row = bill.vendorGstin && bill.billNumber ? rowByKey.get(key) : undefined;
    if (!row) {
      results.push({
        vendorBillId: bill.vendorBillId,
        status: 'missing_in_2b',
        difference: round2(-bill.taxAmount),
        ctin: bill.vendorGstin,
        inum: bill.billNumber,
      });
      continue;
    }
    usedKeys.add(key);
    const twoBTax = lineTax(row);
    const difference = round2(twoBTax - bill.taxAmount);
    results.push({
      vendorBillId: bill.vendorBillId,
      status: Math.abs(difference) < 0.01 ? 'matched' : 'mismatch',
      difference,
      ctin: row.ctin,
      inum: row.inum,
    });
  }

  for (const row of rows) {
    const key = `${(row.ctin || '').toUpperCase()}:${(row.inum || '').trim().toUpperCase()}`;
    if (usedKeys.has(key)) continue;
    results.push({
      vendorBillId: null,
      status: 'missing_in_books',
      difference: lineTax(row),
      ctin: row.ctin,
      inum: row.inum,
    });
  }

  return results;
}

export function gstr2bEligibleItc(rows: Gstr2bB2bRow[]): number {
  return round2(rows.reduce((s, r) => s + lineTax(r), 0));
}

// ---------------------------------------------------------------------------
// Late fee and interest (Sec 47, Sec 50)
// ---------------------------------------------------------------------------

export interface GstRateTableInput {
  lateFeePerDayCgst: number;
  lateFeePerDaySgst: number;
  cap: number;
  interestPct: number;
}

/**
 * The late fee for a return filed `daysLate` days after its due date.
 *
 * ₹per-day CGST plus ₹per-day SGST, for every day late including the due date
 * itself is not late — `daysLate <= 0` is nil. A nil return still attracts a
 * fee at the (lower) nil rate the caller passes in; the nil/non-nil split
 * lives in which `GstRateTable` row the caller chooses, not here.
 */
export function lateFee(daysLate: number, rates: GstRateTableInput): number {
  if (daysLate <= 0) return 0;
  const perDay = rates.lateFeePerDayCgst + rates.lateFeePerDaySgst;
  return round2(Math.min(perDay * daysLate, rates.cap));
}

/**
 * Simple interest (Sec 50(1)) on the net cash tax liability, for the days it
 * ran late. `interestPct` is the annual rate; the daily rate is derived from
 * a 365-day year, which is what the section's "per annum" is read against.
 */
export function interest(netCashTax: number, daysLate: number, interestPct: number): number {
  if (daysLate <= 0 || netCashTax <= 0) return 0;
  return round2((netCashTax * (interestPct / 100) * daysLate) / 365);
}
