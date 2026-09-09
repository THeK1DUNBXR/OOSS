/**
 * Working out what somebody just uploaded.
 *
 * The alternative is asking, and asking is worse than it sounds: a person
 * exporting their books from Tally does not necessarily know whether they
 * produced a Day Book, a Ledger Voucher report or a Trial Balance, and a
 * dropdown of eight formats at the top of an import screen is where most of
 * them give up.
 *
 * So the file is inspected and the finding is shown as a claim the user can
 * correct — "this looks like a Tally ledger export, 1,123 rows, 61 accounts" —
 * rather than as a question they have to answer before seeing anything.
 */

import { isBlank, type Grid, type SheetGrid } from './parse.js';

export type ImportKind =
  | 'tally_ledger'
  | 'bank_statement'
  | 'employees'
  | 'salary'
  | 'attendance'
  | 'transactions'
  | 'chart_of_accounts'
  | 'unknown';

export interface Detection {
  kind: ImportKind;
  /** The sheet this was found on, when the source is a workbook. */
  sheet?: string;
  /** Row index (0-based) of the header, for the grid formats. */
  headerRow?: number;
  confidence: 'high' | 'medium' | 'low';
  /** What the sniffer saw, shown to the user so a wrong guess is arguable. */
  reason: string;
}

const has = (row: string[] | undefined, ...needles: string[]): boolean => {
  if (!row) return false;
  const joined = row.join('|').toLowerCase();
  return needles.every((n) => joined.includes(n.toLowerCase()));
};

/**
 * Finds the header row in a grid that has preamble above it.
 *
 * A bank statement carries sixteen lines of branch address and account number
 * before the columns start, and every one of them parses as a CSV row. Looking
 * for the row that contains the expected column words is more robust than
 * counting lines, because the preamble length varies by bank and by whether
 * the account has a nominee registered.
 */
export function findHeaderRow(grid: Grid, needles: string[][], limit = 40): number {
  for (let i = 0; i < Math.min(grid.length, limit); i += 1) {
    for (const set of needles) {
      if (has(grid[i], ...set)) return i;
    }
  }
  return -1;
}

const BANK_HEADERS: string[][] = [
  ['transaction date', 'particulars'],
  ['date', 'narration'],
  ['date', 'description', 'withdrawal'],
  ['date', 'particulars', 'debit'],
  ['value date', 'debit'],
  ['txn date', 'description'],
];

/** A CSV or a single-sheet grid. */
export function detectGrid(grid: Grid, label?: string): Detection {
  const bankHeader = findHeaderRow(grid, BANK_HEADERS);
  if (bankHeader >= 0) {
    return {
      kind: 'bank_statement',
      sheet: label,
      headerRow: bankHeader,
      confidence: 'high',
      reason:
        bankHeader === 0
          ? 'The first row names a transaction date and a description.'
          : `Row ${bankHeader + 1} names a transaction date and a description, under ${bankHeader} lines of account preamble.`,
    };
  }

  const employeeHeader = findHeaderRow(grid, [['name', 'designation', 'employee code'], ['name', 'division', 'designation']]);
  if (employeeHeader >= 0) {
    return {
      kind: 'employees',
      sheet: label,
      headerRow: employeeHeader,
      confidence: 'high',
      reason: 'The header names people, their division and their designation.',
    };
  }

  const salaryHeader = findHeaderRow(grid, [['name', 'actual salary'], ['name', 'net salary'], ['name', 'gross salary']]);
  if (salaryHeader >= 0) {
    return {
      kind: 'salary',
      sheet: label,
      headerRow: salaryHeader,
      confidence: 'high',
      reason: 'The header names a salary figure per person.',
    };
  }

  // An attendance grid is a row of dates across the top and P/A/L/WO beneath.
  const attendanceHeader = findHeaderRow(grid, [['name', 'days'], ['name', 'date']], 6);
  if (attendanceHeader >= 0 && looksLikeAttendance(grid, attendanceHeader)) {
    return {
      kind: 'attendance',
      sheet: label,
      headerRow: attendanceHeader,
      confidence: 'medium',
      reason: 'Dates run across the top and presence marks run beneath them.',
    };
  }

  const txnHeader = findHeaderRow(grid, [['date', 'amount'], ['date', 'debit', 'credit']]);
  if (txnHeader >= 0) {
    return {
      kind: 'transactions',
      sheet: label,
      headerRow: txnHeader,
      confidence: 'medium',
      reason: 'The header names a date and an amount.',
    };
  }

  return {
    kind: 'unknown',
    sheet: label,
    confidence: 'low',
    reason: 'No recognisable header was found in the first forty rows.',
  };
}

function looksLikeAttendance(grid: Grid, headerRow: number): boolean {
  const marks = new Set(['p', 'a', 'l', 'wo', 'h', 'hd', 'cl', 'sl']);
  let hits = 0;
  for (const row of grid.slice(headerRow + 1, headerRow + 8)) {
    for (const cell of row.slice(1, 20)) {
      if (marks.has(cell.toLowerCase())) hits += 1;
    }
  }
  return hits >= 8;
}

/**
 * A workbook. Each sheet is sniffed and the most informative one wins, because
 * a Tally export carries a Balance Sheet, a P&L and a Trial Balance alongside
 * the vouchers, and only the vouchers hold the transactions.
 */
export function detectWorkbook(sheets: SheetGrid[]): { primary: Detection; perSheet: Detection[] } {
  const perSheet: Detection[] = [];

  for (const sheet of sheets) {
    if (isTallyLedgerSheet(sheet.grid)) {
      perSheet.push({
        kind: 'tally_ledger',
        sheet: sheet.name,
        confidence: 'high',
        reason: `A Tally ledger report: ${countLedgers(sheet.grid)} accounts, each with dated vouchers beneath it.`,
      });
      continue;
    }
    if (isTallyTrialBalance(sheet.grid)) {
      perSheet.push({
        kind: 'chart_of_accounts',
        sheet: sheet.name,
        confidence: 'high',
        reason: 'A Tally trial balance: the chart of accounts with closing balances.',
      });
      continue;
    }
    perSheet.push(detectGrid(sheet.grid, sheet.name));
  }

  const order: ImportKind[] = [
    'tally_ledger', 'bank_statement', 'employees', 'salary',
    'chart_of_accounts', 'attendance', 'transactions', 'unknown',
  ];
  const primary = [...perSheet].sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind))[0];
  return { primary, perSheet };
}

export function isTallyLedgerSheet(grid: Grid): boolean {
  return countLedgers(grid) >= 2 && grid.some((r) => has(r, 'vch type'));
}

export function countLedgers(grid: Grid): number {
  return grid.filter((r) => (r[0] ?? '').toLowerCase() === 'ledger:').length;
}

function isTallyTrialBalance(grid: Grid): boolean {
  const head = grid.slice(0, 12).map((r) => r.join(' ').toLowerCase()).join(' | ');
  return head.includes('trial balance') && grid.some((r) => has(r, 'debit', 'credit'));
}

/** Format, from the bytes and the name. */
export function detectSourceFormat(fileName: string, buffer: Buffer): 'xlsx' | 'csv' | 'tally_xml' | 'unsupported' {
  // A zip container: xlsx and every other OOXML file starts `PK`.
  if (buffer.length > 2 && buffer[0] === 0x50 && buffer[1] === 0x4b) return 'xlsx';

  // Legacy .xls is a compound-document file; SheetJS reads it, and the magic
  // number is worth recognising so the error message is about the right thing.
  if (buffer.length > 8 && buffer[0] === 0xd0 && buffer[1] === 0xcf) return 'xlsx';

  const head = buffer.subarray(0, 4096).toString('utf8').trimStart();
  if (head.startsWith('<?xml') || head.startsWith('<ENVELOPE') || head.toUpperCase().startsWith('<ENVELOPE')) {
    return 'tally_xml';
  }

  const lower = fileName.toLowerCase();
  if (lower.endsWith('.csv') || lower.endsWith('.txt') || head.includes(',')) return 'csv';
  return 'unsupported';
}
