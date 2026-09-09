/**
 * Reading the chart of accounts out of the company's own statements.
 *
 * Classifying a Tally ledger by its name works until it doesn't. "Bank Charges"
 * is not a bank; "ARA Systems" is a supplier and not a cost; "Building Advance"
 * is a deposit the company will get back. Guessing put ₹1.1 lakh of supplier
 * balances into the profit and loss and produced an expense figure twice the
 * real one — plausible, wrong, and the sort of wrong somebody would only find
 * by tying it back to Tally by hand.
 *
 * The workbook already answers the question. A Tally export carries a Profit &
 * Loss and a Balance Sheet beside the vouchers, and between them they name
 * every ledger and say which side of the books it belongs on. So the chart is
 * read rather than inferred, and the name heuristic is left as the fallback for
 * ledgers that appear in neither — which, in a complete export, is none of
 * them.
 */

import type { SheetGrid } from './parse.js';
import { toAmount } from './parse.js';

/** Ledger name (lowercased) to the category kind it belongs to. */
export type LedgerChart = Record<string, string>;

const clean = (s: unknown): string => String(s ?? '').replace(/\s+/g, ' ').trim();

/**
 * Rows that are structure rather than ledgers: subtotals, carried-forward
 * lines, the headings themselves. Matched on the whole name, because "Total"
 * is a subtotal and "Total Quality Consulting" would be a real supplier.
 */
const STRUCTURAL = new Set([
  'total', 'gross profit c/o', 'gross profit b/f', 'gross loss c/o', 'gross loss b/f',
  'nett profit', 'nett loss', 'net profit', 'net loss', 'opening balance',
  'current period', 'profit & loss a/c', 'particulars', 'liabilities', 'assets',
  'difference in opening balances',
]);

/** Group headings, whose members follow them and carry their meaning. */
const GROUPS: Array<{ match: RegExp; kind: string }> = [
  { match: /^income \(direct\)|^income \(indirect\)|^direct incomes|^indirect incomes|^sales accounts/, kind: 'income' },
  { match: /^expenses \(direct\)|^expenses \(indirect\)|^direct expenses|^indirect expenses|^purchase accounts/, kind: 'expense' },
  { match: /^fixed assets/, kind: 'asset_purchase' },
  { match: /^capital account|^reserves/, kind: 'equity' },
  { match: /^loans|^unsecured loans|^secured loans|^bank od/, kind: 'transfer' },
  { match: /^current liabilities|^sundry creditors|^duties & taxes|^provisions/, kind: 'transfer' },
  { match: /^current assets|^deposits|^sundry debtors|^loans & advances|^stock/, kind: 'transfer' },
  { match: /^cash-in-hand|^bank accounts/, kind: 'account' },
];

function groupKind(name: string): string | null {
  const n = name.toLowerCase();
  for (const g of GROUPS) if (g.match.test(n)) return g.kind;
  return null;
}

/**
 * Builds the chart from whichever statements the workbook contains.
 *
 * Both statements are two-column: liabilities/expenses on the left, assets/
 * income on the right. A row with a figure in the *member* column is a ledger;
 * a row with a figure in the *group* column is a heading, and every ledger
 * after it belongs to it until the next heading. That is the whole grammar of
 * a Tally statement, and it holds for the Balance Sheet and the P&L alike.
 */
export function buildChart(sheets: SheetGrid[]): { chart: LedgerChart; sources: string[] } {
  const chart: LedgerChart = {};
  const sources: string[] = [];

  for (const sheet of sheets) {
    const title = sheet.grid.slice(0, 10).map((r) => clean(r[0]).toLowerCase()).join(' | ');
    const isPL = title.includes('profit & loss') || title.includes('profit and loss');
    const isBS = title.includes('balance sheet');
    if (!isPL && !isBS) continue;

    // Left pair is (name, member, group); right pair is (name, member, group).
    for (const side of [
      { name: 0, member: 1, group: 2 },
      { name: 3, member: 4, group: 5 },
    ]) {
      let current: string | null = null;

      for (const row of sheet.grid) {
        const name = clean(row[side.name]);
        if (!name) continue;
        const lower = name.toLowerCase();
        if (STRUCTURAL.has(lower)) continue;

        const memberAmount = toAmount(row[side.member]);
        const groupAmount = toAmount(row[side.group]);

        // A figure in the group column makes this a heading.
        if (groupAmount !== null && memberAmount === null) {
          current = groupKind(name);
          continue;
        }

        // A figure in the member column makes this a ledger under the heading
        // above it.
        if (memberAmount !== null) {
          const kind = current ?? groupKind(name);
          if (kind && kind !== 'account') chart[lower] = kind;
          continue;
        }
      }
    }

    sources.push(sheet.name);
  }

  return { chart, sources };
}

/**
 * The statements name groups the vouchers do not — "Sundry Creditors" totals
 * ₹20,211 without naming the suppliers inside it. A ledger that appears in the
 * vouchers and in neither statement is therefore a balance-sheet account of
 * some kind, and specifically not a cost: it is money owed to somebody, money
 * somebody owes, or a director's account.
 *
 * That inference is worth stating explicitly, because the alternative — falling
 * back to the name heuristic, which defaults to `expense` — is what put every
 * supplier into the profit and loss.
 */
export const UNSTATED_LEDGER_KIND = 'transfer';
