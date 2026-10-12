/**
 * Turning a recognised grid into rows the platform understands.
 *
 * Each extractor produces a `StagedRow`: the original line kept verbatim, plus
 * a normalised object, plus a dedupe key. Nothing here writes to the database —
 * that is `commit.ts` — because the whole point of staging is that a person
 * sees what a file is about to do before it does it.
 */

import { createHash } from 'node:crypto';
import { isBlank, toAmount, toDate, inferDayFirst, type Grid } from './parse.js';
import { findHeaderRow } from './detect.js';
import { classifyLedger, isAccountName } from './classify.js';
import { normaliseName as canonicalName } from './matchName.js';
import type { TemplateSpec } from './templates.js';
import { round2 } from '@kaizen/shared';

export interface StagedRow {
  rowNumber: number;
  raw: Record<string, unknown>;
  normalised: Record<string, unknown> | null;
  status: 'ready' | 'error' | 'skipped';
  message?: string;
  dedupeKey?: string;
}

export interface Extraction {
  rows: StagedRow[];
  /** Anything the user should be told about the file as a whole. */
  notes: string[];
  /** Column headings, so the mapping UI has something to show. */
  columns: string[];
}

// The NUL separator is part of the digest input, so it must stay byte-identical:
// changing it re-keys every stored row hash. It is written as an escape only
// because a raw NUL byte makes git treat this file as binary.
const digest = (...parts: unknown[]): string =>
  createHash('sha256')
    .update(parts.map((p) => String(p ?? '')).join('\0'))
    .digest('hex')
    .slice(0, 32);

const clean = (s: unknown): string =>
  String(s ?? '')
    .replace(/\s+/g, ' ')
    .trim();

// ---------------------------------------------------------------------------
// Tally — the Ledger Vouchers report
// ---------------------------------------------------------------------------

/**
 * Tally's ledger report is one section per account:
 *
 *   Ledger:  Advertisements - Social Media   1-Feb-26 to 27-Mar-27
 *   Date     Particulars      Vch Type  Vch No.  Debit    Credit
 *   19-Aug-26  To  Axis Bank : 9250...  Payment  173      2478.00
 *
 * The section header names one side of the entry and `Particulars` names the
 * other, so each row is a complete double entry and no inference is needed
 * about what the money was for.
 *
 * Every entry therefore appears twice — once under each account it touches —
 * and importing both would double the books. Which copy to keep is decided by
 * what the two sides are, rather than by matching the two halves to each other:
 *
 *   bank ↔ category   keep the row in the BANK section, drop its mirror.
 *   bank ↔ bank       a transfer; keep one side, chosen by name order.
 *   category ↔ category  a non-cash journal; keep one side, likewise.
 *
 * Matching halves by voucher number was the first attempt and it was wrong in a
 * way that took a real file to notice. Tally reuses voucher numbers across
 * voucher types and dates, and a payment split across two expense heads shares
 * one number across three legs — so keying on the voucher collapsed entries
 * that were not duplicates and the bank balance came out ₹71,341 short of
 * Tally's own figure. Taking the bank section as authoritative reproduces
 * Tally's closing balance to the paisa, because it is the same set of rows
 * Tally added up.
 */
export function extractTallyLedger(grid: Grid, chart?: Record<string, string>): Extraction {
  interface Line {
    rowNumber: number;
    ledger: string;
    contra: string;
    date: Date;
    amount: number;
    side: 'debit' | 'credit';
    vchType: string;
    vchNo: string;
    raw: Record<string, unknown>;
  }

  const lines: Line[] = [];
  const rows: StagedRow[] = [];
  const ledgers = new Set<string>();

  let currentLedger: string | null = null;
  let inSection = false;

  // ---- pass one: read every voucher line --------------------------------
  for (let i = 0; i < grid.length; i += 1) {
    const row = grid[i];
    const first = clean(row[0]).toLowerCase();

    if (first === 'ledger:') {
      currentLedger = clean(row[1]);
      if (currentLedger) ledgers.add(currentLedger);
      inSection = false;
      continue;
    }
    if (first === 'date' && clean(row[3]).toLowerCase().startsWith('vch')) {
      inSection = true;
      continue;
    }
    if (!inSection || !currentLedger || isBlank(row)) continue;

    const dateText = clean(row[0]);
    const date = toDate(dateText, true);
    // A section ends with its totals and a closing-balance line. Neither is a
    // transaction, and both lack a date.
    if (!date) continue;

    const contra = clean(row[2]);
    const vchType = clean(row[3]);
    const vchNo = clean(row[4]);
    const debit = toAmount(row[5]);
    const credit = toAmount(row[6]);
    const amount = debit ?? credit;

    const raw = {
      ledger: currentLedger,
      date: dateText,
      direction: clean(row[1]).toLowerCase(),
      contraAccount: contra,
      vchType,
      vchNo,
      debit: row[5] ?? '',
      credit: row[6] ?? '',
    };

    if (amount === null || amount === 0) {
      rows.push({ rowNumber: i + 1, raw, normalised: null, status: 'skipped', message: 'No amount on this line.' });
      continue;
    }

    lines.push({
      rowNumber: i + 1,
      ledger: currentLedger,
      contra,
      date,
      amount: Math.abs(amount),
      side: debit !== null ? 'debit' : 'credit',
      vchType,
      vchNo,
      raw,
    });
  }

  // ---- pass two: decide which copy of each entry to keep ------------------
  //
  // Every entry appears twice, once under each account it touches, and
  // importing both would double the books. Which copy to drop is decided by
  // looking for its exact mirror rather than by a rule about which side wins:
  //
  //   - A line under a non-account ledger is dropped only when the account
  //     section actually contains the same voucher, the same amount and this
  //     ledger as its contra. That is what makes a three-legged voucher work:
  //     a receipt of ₹30,700 that arrives as ₹30,168.17 net of a ₹531.83 gateway
  //     charge has no mirror at the net amount, so the income leg is kept and
  //     the income is recorded gross. Dropping every category line whose contra
  //     was an account recorded that receipt at the net figure and quietly
  //     understated income.
  //
  //   - Two account sections both survive, because a transfer moves money in
  //     two accounts and a model with one account per transaction needs two
  //     rows to say so.
  // How many ledgers each voucher touches. A voucher with more than two legs
  // is a split — a fee taken out of a receipt, one payment across two expense
  // heads — and it is the reason the account leg cannot simply inherit the
  // other side's category: a ₹10,000 course fee arriving as ₹9,752.20 net has
  // an income leg of ₹10,000 and a charges leg of ₹247.80, and letting the
  // bank leg also count as income recorded the fee twice.
  const legCounts = new Map<string, number>();
  for (const line of lines) {
    const v = [line.vchType, line.vchNo, line.date.toISOString().slice(0, 10)].join('~');
    legCounts.set(v, (legCounts.get(v) ?? 0) + 1);
  }

  const mirrors = new Set<string>();
  // The accounts this file actually reports on. An entry naming an account the
  // file does not report on has no other copy anywhere, so that copy is the
  // one that has to carry the movement.
  const reportedAccounts = new Set<string>();
  for (const line of lines) {
    if (!isAccountName(line.ledger, chart)) continue;
    reportedAccounts.add(line.ledger);
    mirrors.add([line.vchType, line.vchNo, line.date.toISOString().slice(0, 10), line.amount, line.contra].join('~'));
  }

  const isProfitAndLoss = (name: string): boolean => {
    const c = classifyLedger(name, chart);
    return c.kind === 'category' && (c.categoryKind === 'income' || c.categoryKind === 'expense');
  };

  let dropped = 0;
  for (const line of lines) {
    const ledgerIsAccount = isAccountName(line.ledger, chart);
    const contraIsAccount = line.contra ? isAccountName(line.contra, chart) : false;

    let keep = true;
    if (!ledgerIsAccount) {
      const key = [line.vchType, line.vchNo, line.date.toISOString().slice(0, 10), line.amount, line.ledger].join('~');
      if (mirrors.has(key)) {
        keep = false;
      } else if (!contraIsAccount) {
        // Both sides are non-cash ledgers — a director paying a supplier
        // personally, a cost settled through a suspense account — so both
        // sections carry this line and one has to be chosen.
        //
        // The profit-and-loss side wins. Chosen alphabetically, "Suspence -
        // Rishikesh" beat "Website/Domin - Expenses" and the cost vanished
        // into a balance-sheet account; ₹85,000 of salary went the same way.
        // Ties fall back to name order so the choice is stable across
        // re-imports.
        const mine = isProfitAndLoss(line.ledger);
        const theirs = isProfitAndLoss(line.contra);
        keep = mine === theirs ? line.ledger.localeCompare(line.contra) <= 0 : mine;
      }
    }

    if (!keep) {
      dropped += 1;
      rows.push({
        rowNumber: line.rowNumber,
        raw: line.raw,
        normalised: null,
        status: 'skipped',
        message: `The same entry is recorded under ${line.contra}, which is where it is taken from.`,
      });
      continue;
    }

    rows.push({
      rowNumber: line.rowNumber,
      raw: line.raw,
      normalised: {
        ledger: line.ledger,
        contraAccount: line.contra,
        ledgerIsAccount,
        contraIsAccount,
        // Whether this line is the one that moves the contra account's
        // balance. It is not, when the file reports on that account
        // separately: a three-legged receipt's income leg is real and must be
        // recorded, but the bank's own section already carries the money that
        // arrived, and posting the leg to the bank as well moved the balance
        // twice.
        postToContra: contraIsAccount && !reportedAccounts.has(line.contra),
        // On a split voucher the account leg carries the cash and not the
        // category: the category legs are kept separately and already say what
        // the money was for.
        isSplitLeg:
          (legCounts.get([line.vchType, line.vchNo, line.date.toISOString().slice(0, 10)].join('~')) ?? 0) > 2,
        txnDate: line.date.toISOString(),
        amount: line.amount,
        // In Tally's ledger view a debit increases the ledger the section is
        // about: money into a bank account, money spent on an expense head.
        side: line.side,
        voucherType: line.vchType,
        voucherNo: line.vchNo,
        narration: `${line.vchType} ${line.vchNo}`.trim(),
      },
      status: 'ready',
      // Guards a re-import of the same export. The two copies of one entry are
      // already resolved above, so this includes the section it came from.
      dedupeKey: digest(
        'tally',
        line.vchType,
        line.vchNo,
        line.date.toISOString().slice(0, 10),
        line.amount,
        line.ledger,
        line.contra,
      ),
    });
  }

  rows.sort((a, b) => a.rowNumber - b.rowNumber);

  return {
    rows,
    notes: [
      `${ledgers.size} ledger accounts.`,
      `${dropped} lines are the second copy of an entry recorded elsewhere in the file, and are left out so the books are not doubled.`,
    ],
    columns: ['ledger', 'date', 'contraAccount', 'vchType', 'vchNo', 'debit', 'credit'],
  };
}

/** The trial balance, which is the chart of accounts with closing balances. */
export function extractTrialBalance(grid: Grid): Extraction {
  const rows: StagedRow[] = [];
  const start = findHeaderRow(grid, [['debit', 'credit']], 20);

  for (let i = start + 1; i < grid.length; i += 1) {
    const row = grid[i];
    const name = clean(row[0]);
    if (!name || name.toLowerCase() === 'grand total') continue;

    const debit = toAmount(row[1]);
    const credit = toAmount(row[2]);
    if (debit === null && credit === null) continue;

    rows.push({
      rowNumber: i + 1,
      raw: { name, debit: row[1], credit: row[2] },
      normalised: {
        name,
        closingDebit: debit ?? 0,
        closingCredit: credit ?? 0,
        // Tally's own grouping is not in this report, so the side of the trial
        // balance is the only signal available. It is a starting suggestion the
        // user can change, not a claim.
        suggestedKind: credit !== null && credit > 0 ? 'income_or_liability' : 'expense_or_asset',
      },
      status: 'ready',
      dedupeKey: digest('coa', name.toLowerCase()),
    });
  }

  return { rows, notes: [`${rows.length} accounts.`], columns: ['name', 'debit', 'credit'] };
}

// ---------------------------------------------------------------------------
// Bank statements
// ---------------------------------------------------------------------------

const pick = (header: string[], ...needles: string[]): number =>
  header.findIndex((h) => {
    const s = h.toLowerCase();
    return needles.some((n) => s.includes(n));
  });

/**
 * A bank statement, in whatever dialect.
 *
 * Columns are located by name rather than by position, because no two banks
 * agree on the order and several put the running balance between the debit and
 * the credit. Both shapes are handled: separate debit/credit columns, and a
 * single signed amount column.
 */
export function extractBankStatement(grid: Grid, headerRow: number): Extraction {
  const header = grid[headerRow] ?? [];
  const notes: string[] = [];

  const cDate = pick(header, 'transaction date', 'txn date', 'date');
  const cValueDate = pick(header, 'value date');
  const cDesc = pick(header, 'particulars', 'narration', 'description', 'remarks');
  const cDebit = pick(header, 'debit', 'withdrawal');
  const cCredit = pick(header, 'credit', 'deposit');
  const cAmount = pick(header, 'amount');
  const cBalance = pick(header, 'balance');
  const cRef = pick(header, 'cheque', 'reference', 'ref no');

  const body = grid.slice(headerRow + 1);
  const dayFirst = inferDayFirst(
    body,
    [cDate, cValueDate].filter((i) => i >= 0),
  );
  notes.push(dayFirst ? 'Dates read day-first (dd/mm/yyyy).' : 'Dates read month-first (mm/dd/yyyy).');

  const separateColumns = cDebit >= 0 && cCredit >= 0 && cDebit !== cCredit;
  notes.push(
    separateColumns
      ? 'Debit and credit are separate columns.'
      : 'A single amount column; its sign gives the direction.',
  );

  const rows: StagedRow[] = [];
  for (let i = 0; i < body.length; i += 1) {
    const row = body[i];
    const rowNumber = headerRow + 2 + i;
    if (isBlank(row)) continue;

    const description = clean(row[cDesc]);
    const dateText = clean(row[cDate]);
    const date = toDate(dateText, dayFirst);

    // An opening-balance line has a balance and no date. It is the statement
    // telling you where it starts, which is worth keeping as the account's
    // opening balance and is not a transaction.
    if (!date) {
      const isOpening = /opening balance/i.test(description);
      rows.push({
        rowNumber,
        raw: { date: dateText, description, debit: row[cDebit], credit: row[cCredit], balance: row[cBalance] },
        normalised: isOpening ? { openingBalance: toAmount(row[cBalance]) ?? 0 } : null,
        status: 'skipped',
        message: isOpening
          ? 'Opening balance — offered as the account’s starting figure.'
          : 'No usable date on this line.',
      });
      continue;
    }

    let amount: number | null;
    let direction: 'in' | 'out';
    if (separateColumns) {
      const debit = toAmount(row[cDebit]);
      const credit = toAmount(row[cCredit]);
      if (debit !== null && debit !== 0) {
        amount = Math.abs(debit);
        direction = 'out';
      } else if (credit !== null && credit !== 0) {
        amount = Math.abs(credit);
        direction = 'in';
      } else {
        amount = null;
        direction = 'out';
      }
    } else {
      const signed = toAmount(row[cAmount]);
      amount = signed === null ? null : Math.abs(signed);
      direction = (signed ?? 0) < 0 ? 'out' : 'in';
    }

    if (amount === null || amount === 0) {
      rows.push({
        rowNumber,
        raw: { date: dateText, description },
        normalised: null,
        status: 'skipped',
        message: 'No amount on this line.',
      });
      continue;
    }

    rows.push({
      rowNumber,
      raw: {
        date: dateText,
        description,
        debit: row[cDebit] ?? '',
        credit: row[cCredit] ?? '',
        balance: row[cBalance] ?? '',
      },
      normalised: {
        txnDate: date.toISOString(),
        amount,
        direction,
        counterparty: counterpartyFrom(description),
        narration: description,
        reference: clean(row[cRef]) || null,
        runningBalance: toAmount(row[cBalance]),
      },
      status: 'ready',
      // Date, amount, direction and the narration. A statement re-downloaded
      // with an overlapping period then recognises what it has already brought
      // in, which is the normal way people import bank data — monthly, with
      // the boundaries not quite lining up.
      dedupeKey: digest('bank', date.toISOString().slice(0, 10), amount, direction, description.slice(0, 60)),
    });
  }

  return {
    rows,
    notes,
    columns: header.filter((h) => h !== ''),
  };
}

/**
 * A guess at who the other party was, from the narration.
 *
 * Bank narrations are a slash-delimited soup: `IMPS/P2A/612016018260/Rishikes/
 * KOTAKMAH/Subscrip/9198943231169485000`. The name is usually the first
 * segment that is alphabetic and not a scheme code, which is a heuristic and
 * is presented as an editable suggestion rather than as a fact.
 */
function counterpartyFrom(description: string): string | null {
  const parts = description
    .split('/')
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length <= 1) return description.slice(0, 60) || null;

  const schemes = new Set([
    'imps',
    'neft',
    'rtgs',
    'upi',
    'p2a',
    'p2m',
    'ach',
    'nach',
    'ecs',
    'inb',
    'mmt',
    'chq',
    'atm',
    'pos',
  ]);
  for (const part of parts.slice(1)) {
    const alpha = part.replace(/[^A-Za-z ]/g, '');
    if (alpha.length >= 4 && !schemes.has(part.toLowerCase())) return alpha.trim();
  }
  return parts[0] ?? null;
}

// ---------------------------------------------------------------------------
// People
// ---------------------------------------------------------------------------

export function extractEmployees(grid: Grid, headerRow: number): Extraction {
  const header = grid[headerRow] ?? [];
  const cName = pick(header, 'name');
  const cDivision = pick(header, 'division', 'department');
  const cDesignation = pick(header, 'designation', 'role', 'title');
  const cDob = pick(header, 'dob', 'date of birth', 'birth');
  const cBlood = pick(header, 'blood');
  const cJoin = pick(header, 'joining', 'doj', 'date of join');
  const cBranch = pick(header, 'branch', 'location');
  const cCode = pick(header, 'employee code', 'emp code', 'code', 'employee id');
  const cEmail = pick(header, 'email');
  const cPhone = pick(header, 'phone', 'mobile', 'contact');

  const rows: StagedRow[] = [];
  for (let i = headerRow + 1; i < grid.length; i += 1) {
    const row = grid[i];
    const name = clean(row[cName]);

    // Real staff sheets carry placeholder rows: a serial number, a division and
    // a pre-allocated employee code, with no person in them yet. They are
    // skipped with a reason rather than imported as people with no name.
    if (!name) {
      if (isBlank(row)) continue;
      rows.push({
        rowNumber: i + 1,
        raw: Object.fromEntries(header.map((h, k) => [h || `col${k}`, row[k] ?? ''])),
        normalised: null,
        status: 'skipped',
        message: 'No name — a reserved row rather than a person.',
      });
      continue;
    }

    const dob = cDob >= 0 ? toDate(row[cDob], false) : null;
    rows.push({
      rowNumber: i + 1,
      raw: Object.fromEntries(header.map((h, k) => [h || `col${k}`, row[k] ?? ''])),
      normalised: {
        fullName: name,
        division: clean(row[cDivision]) || null,
        designation: clean(row[cDesignation]) || null,
        dateOfBirth: dob ? dob.toISOString() : null,
        bloodGroup: clean(row[cBlood]) || null,
        joiningYear: clean(row[cJoin]) || null,
        branch: clean(row[cBranch]) || null,
        employeeCode: clean(row[cCode]) || null,
        email: clean(row[cEmail]) || null,
        phone: clean(row[cPhone]) || null,
      },
      status: 'ready',
      dedupeKey: digest('employee', canonicalName(name)),
    });
  }

  return { rows, notes: [], columns: header.filter((h) => h !== '') };
}

export function extractSalary(grid: Grid, headerRow: number, periodLabel?: string): Extraction {
  const header = grid[headerRow] ?? [];
  const cName = pick(header, 'name');
  const cDesignation = pick(header, 'designation');
  const cActual = pick(header, 'actual salary', 'gross salary', 'salary');
  const cDays = pick(header, 'no.of days', 'no of days', 'days');
  const cLeave = pick(header, 'no.of leave', 'no of leave', 'leave');
  const cNet = pick(header, 'net salary', 'net pay');
  const cDeduction = pick(header, 'deduction');

  const rows: StagedRow[] = [];
  for (let i = headerRow + 1; i < grid.length; i += 1) {
    const row = grid[i];
    const name = clean(row[cName]);
    if (!name) continue;

    const actual = toAmount(row[cActual]);
    if (actual === null) {
      rows.push({
        rowNumber: i + 1,
        raw: Object.fromEntries(header.map((h, k) => [h || `col${k}`, row[k] ?? ''])),
        normalised: null,
        status: 'skipped',
        message: 'No salary figure on this line.',
      });
      continue;
    }

    rows.push({
      rowNumber: i + 1,
      raw: Object.fromEntries(header.map((h, k) => [h || `col${k}`, row[k] ?? ''])),
      normalised: {
        fullName: name,
        designation: clean(row[cDesignation]) || null,
        monthlyAmount: actual,
        daysInPeriod: toAmount(row[cDays]),
        leaveDays: toAmount(row[cLeave]),
        deduction: toAmount(row[cDeduction]) ?? 0,
        netPay: toAmount(row[cNet]),
        periodLabel: periodLabel ?? null,
      },
      status: 'ready',
      dedupeKey: digest('salary', canonicalName(name), periodLabel ?? '', actual),
    });
  }

  return { rows, notes: [], columns: header.filter((h) => h !== '') };
}

/**
 * An attendance grid: dates across the top, one row per person, a mark in each
 * cell.
 *
 * The date row is not always the header row — some months put day names on the
 * header and dates on the line beneath — so the date row is found by looking
 * for the line with the most parseable dates in it.
 */
export function extractAttendance(grid: Grid, headerRow: number, monthLabel?: string): Extraction {
  let dateRowIndex = headerRow;
  let best = 0;
  for (let i = headerRow; i < Math.min(headerRow + 3, grid.length); i += 1) {
    const count = grid[i].filter((c) => toDate(c, false) !== null).length;
    if (count > best) {
      best = count;
      dateRowIndex = i;
    }
  }

  const dateRow = grid[dateRowIndex] ?? [];
  const dates = dateRow.map((c) => toDate(c, false));
  const cName = pick(grid[headerRow] ?? [], 'name');
  const nameCol = cName >= 0 ? cName : 0;

  const MARKS: Record<string, string> = {
    p: 'present',
    a: 'absent',
    l: 'leave',
    wo: 'weekly_off',
    h: 'holiday',
    hd: 'half_day',
    cl: 'leave',
    sl: 'leave',
  };

  const rows: StagedRow[] = [];
  for (let i = dateRowIndex + 1; i < grid.length; i += 1) {
    const row = grid[i];
    const name = clean(row[nameCol]);
    if (!name) continue;

    const days: Array<{ date: string; status: string; mark: string }> = [];
    for (let c = 0; c < dates.length; c += 1) {
      const date = dates[c];
      const mark = clean(row[c]).toLowerCase();
      if (!date || !mark) continue;
      const status = MARKS[mark];
      if (!status) continue;
      days.push({ date: date.toISOString(), status, mark: mark.toUpperCase() });
    }

    if (days.length === 0) continue;

    rows.push({
      rowNumber: i + 1,
      raw: { name, marks: row.slice(0, dates.length).join(' ') },
      normalised: { fullName: name, monthLabel: monthLabel ?? null, days },
      status: 'ready',
      dedupeKey: digest('attendance', canonicalName(name), monthLabel ?? '', days.length),
    });
  }

  return {
    rows,
    notes: [`${best} dated columns.`],
    columns: ['name', ...dates.filter(Boolean).map((d) => d!.toISOString().slice(0, 10))],
  };
}

export { normaliseName } from './matchName.js';

// ---------------------------------------------------------------------------
// A filled-in template
// ---------------------------------------------------------------------------

/**
 * One extractor for every template, driven by the template's own spec.
 *
 * The other extractors in this file each cope with one supplier's idea of a
 * spreadsheet, so each is its own function. These files came from a shape this
 * platform published, so there is exactly one thing to do with them, and
 * writing it seven times would be seven places for the columns to drift from
 * the file that was handed out.
 *
 * Columns are located by heading, not position, so a person who moves a column
 * or deletes one they had nothing for still gets an import.
 */
// ---------------------------------------------------------------------------
// The company's own student register
// ---------------------------------------------------------------------------

/**
 * One row per student, carrying the whole commercial story.
 *
 * This is not a template the platform handed out. It is the register the company
 * already keeps: name, registration number, contact, course, the list fee and
 * the discount off it, the taxable value and the GST, the registration and
 * course dates, and up to three instalments each with its date and the receipt
 * number it was issued under. Reading it is the point of an import — a company
 * should not have to retype a register into our shape before their own figures
 * mean anything.
 *
 * **What the commit writes is the enrolment, and only that**: the course, a
 * batch for it, the student, and their place on it under the registration number
 * the register already gave them. The money columns are read, checked and
 * reported, and not written — the course catalogue's prices are left exactly as
 * they are, and nothing is billed. Every student in this register has already
 * paid what they have paid, against receipts the company issued outside this
 * platform; turning those into invoices and receipts here is a separate decision
 * with a separate audit trail, and an import is the wrong place to make it
 * quietly.
 *
 * The money is still parsed rather than skipped, because a register that does not
 * add up is worth knowing about, and the preview is where somebody finds out.
 *
 * Three things it refuses to do quietly.
 *
 * **Every amount in this register includes tax.** The fee under "Including GST"
 * and every instalment against it are gross figures, so the total governs and
 * the taxable value and the GST are derived back out of it at the rate the row
 * implies. Where the sheet's own "Excluding GST" cell plus its GST cell do not
 * come to that total, it is the split that is wrong — most often a GST figure
 * struck on the gross amount rather than on the taxable one — and the row says
 * so plainly instead of leaving the reader to guess which cell to trust.
 *
 * **It does not absorb an overpayment.** Instalments summing past the total are
 * flagged with the difference. The receipts are real and so is the total; which
 * is wrong is not this file's business to decide.
 *
 * **It does not invent a missing course end date**, or a batch, or an email. An
 * absent cell stays absent.
 */
export function extractStudentRegister(grid: Grid, headerRow: number): Extraction {
  const header = (grid[headerRow] ?? []).map((h) => String(h ?? ''));
  const norm = (v: unknown) =>
    String(v ?? '')
      .toLowerCase()
      .replace(/\s+/g, ' ')
      .trim();

  const at = (...needles: string[]): number => {
    for (const needle of needles) {
      const i = header.findIndex((h) => norm(h) === norm(needle));
      if (i >= 0) return i;
    }
    for (const needle of needles) {
      const i = header.findIndex((h) => norm(h).includes(norm(needle)));
      if (i >= 0) return i;
    }
    return -1;
  };

  const col = {
    name: at('name'),
    registration: at('registration number'),
    contact: at('contact'),
    email: at('mail-id', 'mail id', 'email'),
    course: at('course'),
    listFee: at('actual fees'),
    taxable: at('excluding gst'),
    gst: at('gst'),
    discountAmount: at('discount of rs'),
    discountPct: at('discount'),
    total: at('including gst'),
    registeredOn: at('registration date'),
    startsOn: at('course start date'),
    endsOn: at('course end date'),
    // The register has no date of birth, so an adult must be attested per row. FX-64.
    adultAttested: at('adult (18 or over)', 'adult'),
  };

  // The three instalment triples. Located by walking the header rather than by
  // fixed offsets, because a register that grows a fourth instalment column
  // should not need this function changed.
  const instalmentColumns: Array<{ amount: number; date: number; receipt: number }> = [];
  for (let i = 0; i < header.length; i += 1) {
    if (!/inst[a]?llment/i.test(header[i] ?? '')) continue;
    const date = header.findIndex((h, k) => k > i && norm(h) === 'date');
    const receipt = header.findIndex((h, k) => k > i && norm(h).includes('receipt'));
    instalmentColumns.push({ amount: i, date, receipt });
  }

  const missing: string[] = [];
  if (col.name < 0) missing.push('a student name');
  if (col.course < 0) missing.push('a course');
  if (col.total < 0 && col.taxable < 0) missing.push('a fee');

  const body = grid.slice(headerRow + 1);
  const dateCols = [col.registeredOn, col.startsOn, col.endsOn, ...instalmentColumns.map((i) => i.date)].filter(
    (c) => c >= 0,
  );
  const dayFirst = dateCols.length ? inferDayFirst(body, dateCols) : true;

  const rows: StagedRow[] = [];
  const notes: string[] = [];

  for (let i = headerRow + 1; i < grid.length; i += 1) {
    const row = grid[i] ?? [];
    if (isBlank(row)) continue;

    const raw = Object.fromEntries(header.map((h, k) => [h || `col${k}`, row[k] ?? '']));
    const cell = (c: number): string => (c >= 0 ? clean(row[c]) : '');
    const amount = (c: number): number | null => (c >= 0 ? toAmount(row[c]) : null);
    const when = (c: number): Date | null => (c >= 0 ? toDate(cell(c), dayFirst) : null);

    const fullName = cell(col.name);
    const courseName = cell(col.course);

    // A register has trailing rows with a stray zero in the discount column and
    // nothing else. They are not students.
    if (!fullName && !courseName) continue;

    if (missing.length) {
      rows.push({
        rowNumber: i + 1,
        raw,
        normalised: null,
        status: 'error',
        message: `The file has no column for ${missing.join(' or ')}, which every row needs.`,
      });
      continue;
    }
    if (!fullName) {
      rows.push({ rowNumber: i + 1, raw, normalised: null, status: 'error', message: 'No student name on this row.' });
      continue;
    }
    if (!courseName) {
      rows.push({
        rowNumber: i + 1,
        raw,
        normalised: null,
        status: 'error',
        message: `${fullName} has no course against them, so there is nothing to enrol them on.`,
      });
      continue;
    }

    const sheetTaxable = amount(col.taxable);
    const sheetGst = amount(col.gst);
    const sheetTotal = amount(col.total);
    const warnings: string[] = [];

    // Every amount on the row is tax-inclusive: the total is what the
    // instalments are against and what the receipts add up to, so it governs and
    // the split is derived from it. Where the sheet's own three figures disagree
    // the row names the cell that is wrong rather than leaving it open. None of
    // this is written: it is what the preview shows so that a wrong row is found
    // here rather than in a reconciliation next March.
    let total = sheetTotal;
    let taxable = sheetTaxable;
    let gst = sheetGst;

    if (total === null && taxable !== null) {
      total = round2(taxable + (gst ?? 0));
    }
    if (total === null) {
      rows.push({
        rowNumber: i + 1,
        raw,
        normalised: null,
        status: 'error',
        message: `${fullName} has no fee on the row — neither a total including GST nor a taxable value.`,
      });
      continue;
    }

    if (taxable !== null && gst !== null && Math.abs(round2(taxable + gst) - total) > 1) {
      // The rate the row implies, read off the gross figure the GST was struck
      // on, so that the derived split reconciles with itself.
      const rate = round2((gst / total) * 100);
      const derivedTaxable = round2(total / (1 + rate / 100));
      warnings.push(
        `the taxable value (${taxable}) plus GST (${gst}) comes to ${round2(taxable + gst)}, not the ${total} in the ` +
          `"Including GST" column — every amount in this register is tax-inclusive, so the ${total} is the fee and the ` +
          `"Excluding GST" cell is holding that same gross figure; the figures below take the split back out of the ` +
          `total at ${rate}%, which puts the taxable value at ${derivedTaxable}`,
      );
      taxable = derivedTaxable;
      gst = round2(total - taxable);
    }
    if (taxable === null || gst === null) {
      // No split on the row: infer it at the standard rate for training.
      taxable = round2(total / 1.18);
      gst = round2(total - taxable);
      warnings.push('no taxable/GST split on the row, so 18% has been assumed');
    }

    const gstRate = taxable > 0 ? Math.round((gst / taxable) * 100) : 18;

    const instalments: Array<{ amount: number; paidOn: string | null; receiptNumber: string | null }> = [];
    for (const spec of instalmentColumns) {
      const paid = amount(spec.amount);
      if (paid === null || paid <= 0) continue;
      const paidOn = when(spec.date);
      const receiptNumber = cell(spec.receipt) || null;
      instalments.push({
        amount: paid,
        paidOn: paidOn ? paidOn.toISOString() : null,
        receiptNumber,
      });
      if (!receiptNumber) {
        warnings.push(`an instalment of ${paid} has no receipt number against it`);
      }
      if (!paidOn) {
        warnings.push(`an instalment of ${paid} has no date against it`);
      }
    }

    const received = round2(instalments.reduce((sum, r) => sum + r.amount, 0));
    if (received > total + 0.5) {
      warnings.push(
        `the instalments come to ${received}, which is ${round2(received - total)} more than the ${total} owed — ` +
          'either a receipt or the fee is wrong on this row',
      );
    }

    const registeredOn = when(col.registeredOn);
    const startsOn = when(col.startsOn);
    const endsOn = when(col.endsOn);
    if (startsOn && endsOn && endsOn < startsOn) {
      warnings.push('the course end date is before its start date');
    }

    const phoneDigits = cell(col.contact).replace(/\D/g, '');
    const email = cell(col.email).toLowerCase();

    const normalised = {
      fullName,
      registrationNumber: cell(col.registration) || null,
      adultAttested: /^(y|yes|true)$/i.test(cell(col.adultAttested).trim()),
      primaryPhone: phoneDigits || null,
      primaryEmail: email && email.includes('@') ? email : null,
      courseName,
      listFee: amount(col.listFee),
      discountAmount: amount(col.discountAmount),
      taxable,
      gst,
      gstRate,
      total,
      registeredOn: registeredOn ? registeredOn.toISOString() : null,
      startsOn: startsOn ? startsOn.toISOString() : null,
      endsOn: endsOn ? endsOn.toISOString() : null,
      instalments,
      received,
      // Carried through to the preview and the commit, so a person sees what is
      // odd about a row before it is written and afterwards.
      warnings,
    };

    rows.push({
      rowNumber: i + 1,
      raw,
      normalised,
      status: 'ready',
      // The enrolment imports either way. The note is about the register, not
      // about what is being written — and it is the reason somebody should look
      // at this row.
      ...(warnings.length ? { message: `The register does not add up here: ${warnings.join('; ')}.` } : {}),
      // The registration number is the company's own identifier for the
      // enrolment, so it is the dedupe key where there is one. Falling back to
      // name-and-course means a register without them still does not import
      // twice.
      dedupeKey: digest(
        'student_register',
        normalised.registrationNumber ?? `${canonicalName(fullName)}|${canonicalName(courseName)}`,
      ),
    });
  }

  notes.push(
    'This import writes the enrolment only: the course, a batch for it, the student, and their place on it under the ' +
      'registration number the register gives them. Course prices are left exactly as they are and nothing is billed.',
  );

  const money = rows.reduce(
    (acc, r) => {
      const n = r.normalised as { total?: number; received?: number; instalments?: unknown[] } | null;
      if (!n) return acc;
      return {
        owed: round2(acc.owed + (n.total ?? 0)),
        received: round2(acc.received + (n.received ?? 0)),
        instalments: acc.instalments + (n.instalments?.length ?? 0),
      };
    },
    { owed: 0, received: 0, instalments: 0 },
  );
  if (money.owed > 0) {
    notes.push(
      `Read and not written: fees of ${money.owed} against these students, of which ${money.received} is shown as ` +
        `received across ${money.instalments} instalment${money.instalments === 1 ? '' : 's'}. Raise the invoices in ` +
        'the product if you want them on the books, so each one has its own document and its own audit trail.',
    );
  }

  const flagged = rows.filter((r) => r.message).length;
  if (flagged) {
    notes.push(
      `${flagged} of ${rows.length} rows carry a note about what did not add up in the register. None of them has been ` +
        'silently corrected, and none of it affects what is written.',
    );
  }
  const courses = new Set(
    rows.map((r) => (r.normalised as { courseName?: string } | null)?.courseName).filter(Boolean),
  );
  if (courses.size) {
    notes.push(
      `${courses.size} course${courses.size === 1 ? '' : 's'} named: ${[...courses].join(', ')}. ` +
        'A course not already on file is created with no fee against it, for somebody to price deliberately.',
    );
  }

  return { rows, notes, columns: header.filter(Boolean) };
}

export function extractTemplate(grid: Grid, spec: TemplateSpec, headerRow: number): Extraction {
  const header = (grid[headerRow] ?? []).map((h) => String(h ?? ''));
  const norm = (s: unknown) =>
    String(s ?? '')
      .toLowerCase()
      .replace(/\s+/g, ' ')
      .trim();
  const index = new Map(header.map((h, i) => [norm(h), i]));

  const columns = spec.columns.map((c) => ({ ...c, at: index.get(norm(c.name)) ?? -1 }));
  const missing = columns.filter((c) => c.required && c.at < 0);

  // Dates are read from whichever column carries them, using the same
  // day-first/month-first inference as a bank statement — an Indian file writes
  // 03/09/2026 meaning September.
  const dateCols = columns.filter((c) => c.as === 'date' && c.at >= 0).map((c) => c.at);
  const body = grid.slice(headerRow + 1);
  const dayFirst = dateCols.length ? inferDayFirst(body, dateCols) : true;

  const rows: StagedRow[] = [];
  for (let i = headerRow + 1; i < grid.length; i += 1) {
    const row = grid[i] ?? [];
    if (isBlank(row)) continue;

    const raw = Object.fromEntries(header.map((h, k) => [h || `col${k}`, row[k] ?? '']));

    if (missing.length) {
      rows.push({
        rowNumber: i + 1,
        raw,
        normalised: null,
        status: 'error',
        message: `The file is missing ${missing.map((m) => `"${m.name}"`).join(' and ')}, which every row needs.`,
      });
      continue;
    }

    const normalised: Record<string, unknown> = {};
    let refusal: string | null = null;

    for (const col of columns) {
      const cell = col.at >= 0 ? row[col.at] : '';
      const text = clean(cell);

      if (!text) {
        if (col.required) refusal ??= `${col.name} is blank, and every row needs one.`;
        normalised[col.field] = null;
        continue;
      }

      switch (col.as) {
        case 'number': {
          const n = toAmount(cell);
          if (n === null) {
            refusal ??= `${col.name} reads "${text}", which is not a number.`;
            normalised[col.field] = null;
          } else {
            normalised[col.field] = n;
          }
          break;
        }
        case 'date': {
          const d = toDate(cell, dayFirst);
          if (!d) {
            refusal ??= `${col.name} reads "${text}", which is not a date this can read. Write it as DD/MM/YYYY.`;
            normalised[col.field] = null;
          } else {
            normalised[col.field] = d.toISOString();
          }
          break;
        }
        case 'yesno': {
          const yes = /^(y|yes|true|1)$/i.test(text);
          const no = /^(n|no|false|0)$/i.test(text);
          if (!yes && !no) {
            refusal ??= `${col.name} reads "${text}". Write Yes or No.`;
            normalised[col.field] = null;
          } else {
            normalised[col.field] = yes;
          }
          break;
        }
        default:
          normalised[col.field] = text;
      }
    }

    rows.push({
      rowNumber: i + 1,
      raw,
      normalised: refusal ? null : normalised,
      status: refusal ? 'error' : 'ready',
      ...(refusal ? { message: refusal } : {}),
      // Dedupe on the row's own identity so re-uploading a corrected file does
      // not create a second copy of everything that was already fine.
      ...(refusal
        ? {}
        : { dedupeKey: digest(spec.kind, ...spec.columns.filter((c) => c.required).map((c) => normalised[c.field])) }),
    });
  }

  const dropped = columns.filter((c) => !c.required && c.at < 0);
  return {
    rows,
    columns: header.filter(Boolean),
    notes: [
      `Read as the ${spec.title} template.`,
      ...(dropped.length
        ? [
            `These columns are not in the file, so nothing was recorded for them: ${dropped.map((d) => d.name).join(', ')}.`,
          ]
        : []),
      ...spec.notes,
    ],
  };
}
