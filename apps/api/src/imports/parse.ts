/**
 * Turning a file into a grid.
 *
 * Everything downstream — the sniffer, the mappers, the commit — works on
 * `string[][]`. That is deliberate: a bank statement, a Tally export and a
 * payroll spreadsheet are all a grid with some rubbish at the top, and having
 * one representation means the awkward parts (finding the header, coercing a
 * date, reading an amount written as `"\t25,000.00"`) are solved once.
 */

import * as XLSX from 'xlsx';

export type Grid = string[][];

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------

/**
 * RFC 4180, including the parts people actually hit: quoted fields containing
 * commas and newlines, and `""` as an escaped quote.
 *
 * Hand-written rather than pulled in, because the failure mode of a CSV
 * library that quietly differs from the bank's dialect is a ledger that is
 * wrong by one row, and this is sixty lines.
 */
export function parseCsv(text: string): Grid {
  // Strip a UTF-8 BOM: Excel writes one, and it otherwise becomes part of the
  // first column name and nothing matches it.
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;

  const rows: Grid = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];

    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\r') {
      // Swallowed; the \n that follows ends the row.
    } else if (ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += ch;
    }
  }

  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  return rows.map((r) => r.map((c) => c.trim()));
}

// ---------------------------------------------------------------------------
// Spreadsheets
// ---------------------------------------------------------------------------

export interface SheetGrid {
  name: string;
  grid: Grid;
}

/**
 * Every sheet in the workbook, as text.
 *
 * `raw: false` asks the reader for the formatted string rather than the
 * underlying number, which is what makes a date come back as `12-Aug-26`
 * instead of `46251`. The importer would rather parse a human date than guess
 * an epoch — Excel has two, and picking the wrong one moves every transaction
 * by four years.
 */
export function readWorkbook(buffer: Buffer): SheetGrid[] {
  const wb = XLSX.read(buffer, { type: 'buffer', cellDates: false });
  return wb.SheetNames.map((name) => ({
    name,
    grid: (XLSX.utils.sheet_to_json(wb.Sheets[name], {
      header: 1,
      raw: false,
      defval: '',
      blankrows: true,
    }) as unknown[][]).map((r) => r.map((c) => (c == null ? '' : String(c).trim()))),
  }));
}

// ---------------------------------------------------------------------------
// Coercion
// ---------------------------------------------------------------------------

/**
 * A number written by a human or by a bank.
 *
 * Handles thousands separators, the tab a statement export leaves in front of
 * the figure, currency symbols, a trailing `Dr`/`Cr`, and parentheses for
 * negatives. Returns null rather than NaN, because null is a value the caller
 * has to decide about and NaN is one that propagates.
 */
export function toAmount(input: string | number | null | undefined): number | null {
  if (input == null) return null;
  if (typeof input === 'number') return Number.isFinite(input) ? input : null;

  // The \u00A0 is deliberate and is written as an escape so it is visible:
  // spreadsheet exports routinely use a non-breaking space as the thousands
  // separator, and a literal one here reads as an ordinary space.
  let s = input.replace(/[\s\u00A0\t]/g, '').replace(/[₹$€£,]/g, '');
  if (s === '' || s === '-') return null;

  let sign = 1;
  if (/^\(.*\)$/.test(s)) {
    sign = -1;
    s = s.slice(1, -1);
  }
  const drCr = s.match(/(dr|cr)$/i);
  if (drCr) {
    if (drCr[1].toLowerCase() === 'cr') sign *= -1;
    s = s.slice(0, -2);
  }
  if (s.startsWith('-')) {
    sign *= -1;
    s = s.slice(1);
  }

  if (!/^\d*\.?\d*$/.test(s) || s === '' || s === '.') return null;
  const n = Number(s);
  return Number.isFinite(n) ? sign * n : null;
}

const MONTHS: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, sept: 8, oct: 9, nov: 10, dec: 11,
};

/**
 * A date in one of the formats these files actually use.
 *
 * `dayFirst` decides 01/05/2026. It is a parameter rather than a guess because
 * the two readings are five months apart and both are plausible: Indian bank
 * statements are day-first, and an Excel sheet written on a US locale is not.
 * The sniffer infers it from the file and the user can override it before
 * commit — which is the only honest way to handle a genuinely ambiguous value.
 */
export function toDate(input: string | null | undefined, dayFirst = true): Date | null {
  if (!input) return null;
  const s = String(input).trim();
  if (!s) return null;

  // 12-Aug-26 / 12 Aug 2026 / 12-August-2026
  const named = s.match(/^(\d{1,2})[-/\s]([A-Za-z]{3,9})[-/\s](\d{2,4})$/);
  if (named) {
    const month = MONTHS[named[2].slice(0, 4).toLowerCase()] ?? MONTHS[named[2].slice(0, 3).toLowerCase()];
    if (month !== undefined) return utc(expandYear(Number(named[3])), month, Number(named[1]));
  }

  // August 12, 2026
  const usNamed = s.match(/^([A-Za-z]{3,9})\s+(\d{1,2}),?\s+(\d{4})$/);
  if (usNamed) {
    const month = MONTHS[usNamed[1].slice(0, 4).toLowerCase()] ?? MONTHS[usNamed[1].slice(0, 3).toLowerCase()];
    if (month !== undefined) return utc(Number(usNamed[3]), month, Number(usNamed[2]));
  }

  // 2026-08-12 — unambiguous, so it never consults dayFirst.
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return utc(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]));

  // 12/08/2026 or 08/12/2026
  const numeric = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})$/);
  if (numeric) {
    const a = Number(numeric[1]);
    const b = Number(numeric[2]);
    const year = expandYear(Number(numeric[3]));
    // A value above 12 settles it whatever the caller asked for.
    if (a > 12) return utc(year, b - 1, a);
    if (b > 12) return utc(year, a - 1, b);
    return dayFirst ? utc(year, b - 1, a) : utc(year, a - 1, b);
  }

  return null;
}

function expandYear(y: number): number {
  if (y >= 1000) return y;
  // A two-digit year in a business file is this century. 26 is 2026, not 1926.
  return y < 70 ? 2000 + y : 1900 + y;
}

function utc(year: number, month: number, day: number): Date | null {
  if (month < 0 || month > 11 || day < 1 || day > 31) return null;
  const d = new Date(Date.UTC(year, month, day));
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Whether a grid's ambiguous dates read better day-first.
 *
 * Counts the values that can only be one or the other. If a column holds
 * `13/04/2026` anywhere, the file is day-first and every other value in it
 * should be read that way — which is a far better signal than the locale of
 * whoever is running the import.
 */
export function inferDayFirst(grid: Grid, columns: number[]): boolean {
  let dayFirst = 0;
  let monthFirst = 0;
  for (const row of grid) {
    for (const c of columns) {
      const m = String(row[c] ?? '').match(/^(\d{1,2})[/.-](\d{1,2})[/.-]\d{2,4}$/);
      if (!m) continue;
      const a = Number(m[1]);
      const b = Number(m[2]);
      if (a > 12 && b <= 12) dayFirst += 1;
      else if (b > 12 && a <= 12) monthFirst += 1;
    }
  }
  // Ties go to day-first: this is an Indian company, and every bank statement
  // and Tally export it will ever see is dd/mm.
  return dayFirst >= monthFirst;
}

/** Rows with something in them. */
export function nonEmpty(grid: Grid): Grid {
  return grid.filter((r) => r.some((c) => c !== ''));
}

export function isBlank(row: string[] | undefined): boolean {
  return !row || row.every((c) => c === '');
}
